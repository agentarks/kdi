import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "./db";
import { TASK_COLUMNS, type Task, promoteScheduledTasks, hydrateTask } from "./models/task";
import { finishRun, updateRun } from "./models/taskRun";
import { addEvent } from "./models/taskEvent";
import { atomicClaim, heartbeat } from "./models/claim";
import { isBlockedByDependencies } from "./models/dependency";
import { getProfile, substituteCommand } from "./profiles";
import { createWorktree, removeWorktree, type RemoveWorktreeResult } from "./worktree";
import { isEnabled, FF_ENABLE_KANBAN_DISPATCH } from "./flags";
import {
  recordTick,
  recordClaim,
  recordTaskDuration,
  recordAgentError,
  recordTaskAge,
  logToBoard,
  getTaskLogPath,
} from "./observability";

export interface HarnessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
}

export interface TickOptions {
  spawnHarness?: (command: string, cwd: string, logPath?: string, timeoutMs?: number, env?: Record<string, string>) => Promise<HarnessResult>;
  createWorktree?: (repoDir: string, profile: string, taskId: string, baseRef: string) => string;
  removeWorktree?: (repoDir: string, profile: string, taskId: string, worktreePath?: string) => RemoveWorktreeResult;
  maxSpawnsPerTick?: number;
}

export interface TickResult {
  processed: number;
}

export async function spawnHarness(command: string, cwd: string, logPath?: string, timeoutMs: number = 300000, env?: Record<string, string>): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;
    const child = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv });

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

    let logStream: ReturnType<typeof createWriteStream> | undefined;
    if (logPath) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        logStream = createWriteStream(logPath);
      } catch {
        // Best effort logging
      }
    }

    child.stdout!.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (logStream) {
        try { logStream.write(chunk); } catch {}
      }
    });

    child.stderr!.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (logStream) {
        try { logStream.write(chunk); } catch {}
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (logStream) {
        try { logStream.end(); } catch {}
      }
      resolve({ stdout, stderr, exitCode: code ?? 0, pid: child.pid ?? undefined });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (logStream) {
        try { logStream.end(); } catch {}
      }
      reject(err);
    });
  });
}

function listReadyTasks(): Task[] {
  const db = getDb();
  const rows = db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = 'ready' AND archived_at IS NULL ORDER BY priority DESC, created_at ASC`
  ).all() as Task[];
  return rows.map(hydrateTask);
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

function getBoardBaseRef(boardId: number): string | null {
  const db = getDb();
  const board = db.query(
    `SELECT base_ref FROM boards WHERE id = ? AND archived_at IS NULL`
  ).get(boardId) as { base_ref: string } | undefined;
  return board?.base_ref ?? null;
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
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, consecutive_failures = 0, claim_lock = NULL, claim_expires = NULL, updated_at = unixepoch() WHERE id = ?`,
    [result, result.slice(0, 200), id]
  );
  if (runId !== null) {
    finishRun(runId, "completed", result.slice(0, 200), null, null);
  }
  addEvent(id, "finished", { outcome: "completed" }, runId ?? undefined);
}

function determineOutcome(reason: string): Parameters<typeof finishRun>[1] {
  if (reason.includes("spawn")) return "spawn_failed";
  if (reason.includes("timed out") || reason.includes("timeout")) return "timed_out";
  if (reason.includes("crashed")) return "crashed";
  return "blocked";
}

function blockTask(id: number, result: string, blockReason: string, runError: string, runId: number | null, consecutiveFailures: number): void {
  const db = getDb();
  db.run(
    `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, consecutive_failures = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
    [result, blockReason, consecutiveFailures, id]
  );
  const outcome = determineOutcome(runError);
  if (runId !== null) {
    finishRun(runId, outcome, null, null, runError);
  }
  addEvent(id, "blocked", { reason: blockReason, run_error: runError, consecutive_failures: consecutiveFailures }, runId ?? undefined);
}

function requeueTask(id: number, reason: string, runId: number | null, consecutiveFailures?: number): void {
  const db = getDb();
  const updates = ["status = 'ready'", "result = ?", "claim_lock = NULL", "claim_expires = NULL", "started_at = NULL", "updated_at = unixepoch()"];
  const params: any[] = [reason];
  if (consecutiveFailures !== undefined) {
    updates.push("consecutive_failures = ?");
    params.push(consecutiveFailures);
  }
  params.push(id);
  db.run(
    `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
    params
  );
  if (runId !== null) {
    finishRun(runId, "reclaimed", null, null, reason);
  }
  addEvent(id, "reclaimed", { reason, consecutive_failures: consecutiveFailures }, runId ?? undefined);
}

function handleFailure(task: Task, result: string, reason: string, runId: number | null): void {
  const consecutiveFailures = task.consecutive_failures + 1;
  const hasMaxRetries = task.max_retries !== null && task.max_retries !== undefined;

  if (hasMaxRetries && consecutiveFailures >= task.max_retries!) {
    const blockReason = `Circuit breaker: ${consecutiveFailures} consecutive failures`;
    blockTask(task.id, result, blockReason, reason, runId, consecutiveFailures);
  } else if (hasMaxRetries) {
    requeueTask(task.id, reason, runId, consecutiveFailures);
  } else {
    blockTask(task.id, result, reason, reason, runId, consecutiveFailures);
  }
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
  const maxSpawns = options.maxSpawnsPerTick ?? Infinity;

  recordTick();

  if (!isEnabled(FF_ENABLE_KANBAN_DISPATCH)) {
    return { processed: 0 };
  }

  reapStaleClaims();
  promoteScheduledTasks(Math.floor(Date.now() / 1000));

  const tasks = listReadyTasks();
  let processed = 0;
  let spawned = 0;

  for (const task of tasks) {
    if (spawned >= maxSpawns) {
      break;
    }

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
      handleFailure(task, "", "Board not found or archived", runId);
      spawned++;
      continue;
    }

    const baseRef = getBoardBaseRef(task.board_id) ?? "origin/main";

    let profile;
    try {
      profile = getProfile(task.assignee ?? "opencode");
    } catch {
      handleFailure(task, "", `Unknown profile: ${task.assignee ?? "opencode"}`, runId);
      spawned++;
      continue;
    }

    const worktreeBranch = `wt/${profile.name}/${task.id}`;

    let worktreePath: string;
    try {
      worktreePath = doCreateWorktree(workdir, profile.name, String(task.id), baseRef);
    } catch (err: any) {
      handleFailure(task, "", `Worktree creation failed: ${err.message}`, runId);
      spawned++;
      continue;
    }

    const boardSlug = getBoardSlug(task.board_id);
    const logPath = boardSlug ? getTaskLogPath(boardSlug, task.id) : undefined;

    try {
      const skillsValue = task.skills && task.skills.length > 0 ? task.skills.join(",") : "";
      const modelValue = task.model_override ?? "";
      const command = substituteCommand(profile.command, {
        workdir: worktreePath,
        branch: worktreeBranch,
        task_id: String(task.id),
        agent: profile.agent ?? profile.name,
        skills: skillsValue,
        model: modelValue,
      });

      const harnessEnv: Record<string, string> | undefined = {};
      if (skillsValue) harnessEnv.KDI_SKILLS = skillsValue;
      if (modelValue) harnessEnv.KDI_MODEL = modelValue;
      const effectiveHarnessEnv = Object.keys(harnessEnv).length > 0 ? harnessEnv : undefined;
      const harnessTimeoutMs = task.max_runtime_seconds ? task.max_runtime_seconds * 1000 : undefined;
      const harnessStart = Date.now();
      const harnessResult = await doSpawnHarness(command, worktreePath, logPath, harnessTimeoutMs, effectiveHarnessEnv);
      const harnessDuration = Date.now() - harnessStart;
      recordTaskDuration(profile.agent ?? profile.name, harnessDuration);

      const { stdout, stderr, exitCode } = harnessResult;
      const pid = harnessResult.pid ?? 0;

      if (runId !== null && pid) {
        updateRun(runId, { worker_pid: pid });
      }

      if (exitCode === 0) {
        finishTask(task.id, stdout, runId);
        processed++;
      } else if (exitCode === 75) {
        // EX_TEMPFAIL — requeue to ready without counting as failure
        requeueTask(task.id, `Rate-limited (EX_TEMPFAIL), requeued to ready: ${stderr || stdout}`, runId);
      } else {
        recordAgentError(profile.agent ?? profile.name);
        handleFailure(task, stdout, `Harness failed (exit ${exitCode}): ${stderr || "unknown error"}`, runId);
      }

      spawned++;
    } catch (err: any) {
      recordAgentError(profile.agent ?? profile.name);
      handleFailure(task, "", `Harness execution failed: ${err.message}`, runId);
      spawned++;
    } finally {
      try {
        doRemoveWorktree(workdir, profile.name, String(task.id), worktreePath);
      } catch {
        // Best effort cleanup
      }
    }

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
  stop: () => Promise<void>;
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
      if (!running) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  const loopPromise = loop();

  return {
    stop: async () => {
      running = false;
      await loopPromise;
    },
  };
}
