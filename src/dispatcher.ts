import { spawn } from "node:child_process";
import { getDb } from "./db";
import { TASK_COLUMNS, type Task } from "./models/task";
import { finishRun } from "./models/taskRun";
import { addEvent } from "./models/taskEvent";
import { atomicClaim, heartbeat } from "./models/claim";
import { isBlockedByDependencies } from "./models/dependency";
import { getProfile, substituteCommand } from "./profiles";
import { createWorktree, removeWorktree } from "./worktree";
import { isEnabled, FF_ENABLE_KANBAN_DISPATCH } from "./flags";
import {
  recordTick,
  recordClaim,
  recordTaskDuration,
  recordAgentError,
  recordTaskAge,
  logToBoard,
} from "./observability";

export interface HarnessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TickOptions {
  spawnHarness?: (command: string, cwd: string) => Promise<HarnessResult>;
  createWorktree?: (repoDir: string, profile: string, taskId: string) => string;
  removeWorktree?: (repoDir: string, profile: string, taskId: string) => boolean;
}

export interface TickResult {
  processed: number;
}

function parseShellCommand(command: string): [string, string[]] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\" && !inSingleQuote) {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  if (args.length === 0) {
    throw new Error("Empty command");
  }

  const [cmd, ...rest] = args;
  return [cmd, rest];
}

export async function spawnHarness(command: string, cwd: string, timeoutMs: number = 300000): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = parseShellCommand(command);
    const child = spawn(cmd, args, { shell: false, cwd, stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
      reject(new Error(`Harness timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (data) => { stdout += data.toString(); });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function listReadyTasks(): Task[] {
  const db = getDb();
  return db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = 'ready' AND archived_at IS NULL ORDER BY created_at ASC`
  ).all() as Task[];
}

function claimTask(id: number, assignee: string | null): { success: boolean; runId: number | null } {
  const result = atomicClaim(id, assignee ?? "opencode");
  if (!result.success) {
    return { success: false, runId: null };
  }
  return { success: true, runId: result.runId ?? null };
}

function getBoardWorkdir(boardId: number): string | null {
  const db = getDb();
  const board = db.query(
    `SELECT workdir FROM boards WHERE id = ? AND archived_at IS NULL`
  ).get(boardId) as { workdir: string } | undefined;
  return board?.workdir ?? null;
}

function getBoardSlug(boardId: number): string | null {
  const db = getDb();
  const board = db.query(
    `SELECT slug FROM boards WHERE id = ? AND archived_at IS NULL`
  ).get(boardId) as { slug: string } | undefined;
  return board?.slug ?? null;
}

function finishTask(id: number, result: string, runId: number | null): void {
  const db = getDb();
  db.run(
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, claim_lock = NULL, claim_expires = NULL, updated_at = unixepoch() WHERE id = ?`,
    [result, result.slice(0, 200), id]
  );
  if (runId !== null) {
    finishRun(runId, "completed", result.slice(0, 200), null, null);
  }
  addEvent(id, "finished", { outcome: "completed" }, runId ?? undefined);
}

function failTask(id: number, result: string, reason: string, runId: number | null): void {
  const db = getDb();
  db.run(
    `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
    [result, reason, id]
  );
  let outcome: Parameters<typeof finishRun>[1] = "blocked";
  if (reason.includes("spawn")) {
    outcome = "spawn_failed";
  } else if (reason.includes("timed out") || reason.includes("timeout")) {
    outcome = "timed_out";
  } else if (reason.includes("crashed")) {
    outcome = "crashed";
  }
  if (runId !== null) {
    finishRun(runId, outcome, null, null, reason);
  }
  addEvent(id, "finished", { outcome, reason }, runId ?? undefined);
}

function reapStaleClaims(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;

  // Find stale claims and their active runs
  const staleTasks = db.query(
    `SELECT id, current_run_id FROM tasks WHERE status = 'running' AND (claim_expires < ? OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?))`
  ).all(now, oneHourAgo) as { id: number; current_run_id: number | null }[];

  for (const stale of staleTasks) {
    if (stale.current_run_id) {
      finishRun(stale.current_run_id, "reclaimed", null, null, "Reclaimed by dispatcher: stale claim");
    }
    addEvent(stale.id, "reclaimed", { reason: "stale claim detected by dispatcher" });
  }

  db.run(
    `UPDATE tasks SET status = 'ready', started_at = NULL, claim_lock = NULL, claim_expires = NULL, updated_at = unixepoch() WHERE status = 'running' AND (claim_expires < ? OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?))`,
    [now, oneHourAgo]
  );
}

export async function tick(options: TickOptions = {}): Promise<TickResult> {
  const doSpawnHarness = options.spawnHarness ?? spawnHarness;
  const doCreateWorktree = options.createWorktree ?? createWorktree;
  const doRemoveWorktree = options.removeWorktree ?? removeWorktree;

  recordTick();

  if (!isEnabled(FF_ENABLE_KANBAN_DISPATCH)) {
    return { processed: 0 };
  }

  reapStaleClaims();

  const tasks = listReadyTasks();
  let processed = 0;

  for (const task of tasks) {
    if (isBlockedByDependencies(task.id)) {
      continue;
    }

    const taskAgeMs = Date.now() - task.created_at * 1000;
    recordTaskAge(taskAgeMs);

    const claimResult = claimTask(task.id, task.assignee);
    recordClaim(claimResult.success);
    if (!claimResult.success) {
      continue;
    }
    const runId = claimResult.runId;

    // Record initial heartbeat for worker liveness
    heartbeat(task.id);

    const workdir = getBoardWorkdir(task.board_id);
    if (!workdir) {
      failTask(task.id, "", "Board not found or archived", runId);
      processed++;
      continue;
    }

    let profile;
    try {
      profile = getProfile(task.assignee ?? "opencode");
    } catch {
      failTask(task.id, "", `Unknown profile: ${task.assignee ?? "opencode"}`, runId);
      processed++;
      continue;
    }

    let worktreePath: string;
    try {
      worktreePath = doCreateWorktree(workdir, profile.name, String(task.id));
    } catch (err: any) {
      failTask(task.id, "", `Worktree creation failed: ${err.message}`, runId);
      processed++;
      continue;
    }

    try {
      const command = substituteCommand(profile.command, {
        workdir: worktreePath,
        branch: task.branch ?? "main",
        task_id: String(task.id),
        agent: profile.agent ?? profile.name,
      });

      const harnessStart = Date.now();
      const { stdout, stderr, exitCode } = await doSpawnHarness(command, worktreePath);
      const harnessDuration = Date.now() - harnessStart;
      recordTaskDuration(profile.agent ?? profile.name, harnessDuration);

      if (exitCode === 0) {
        finishTask(task.id, stdout, runId);
      } else {
        recordAgentError(profile.agent ?? profile.name);
        failTask(task.id, stdout, `Harness failed (exit ${exitCode}): ${stderr || "unknown error"}`, runId);
      }

      processed++;
    } catch (err: any) {
      recordAgentError(profile.agent ?? profile.name);
      failTask(task.id, "", `Harness execution failed: ${err.message}`, runId);
      processed++;
    } finally {
      try {
        doRemoveWorktree(workdir, profile.name, String(task.id));
      } catch {
        // Best effort cleanup
      }
    }

    const boardSlug = getBoardSlug(task.board_id);
    if (boardSlug) {
      const updated = (await import("./models/task")).showTask(task.id);
      if (updated) {
        const message = `Task #${task.id} "${task.title}" completed with status=${updated.status}`;
        logToBoard(boardSlug, message);
      }
    }
  }

  return { processed };
}

export interface DispatcherHandle {
  stop: () => void;
}

export function startDispatcher(pollIntervalMs: number = 5000, options?: TickOptions): DispatcherHandle {
  let running = true;

  async function loop() {
    while (running) {
      try {
        await tick(options);
      } catch (err) {
        console.error("Dispatcher tick failed:", err);
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}
