import { spawn } from "node:child_process";
import { getDb } from "./db";
import { TASK_COLUMNS, type Task } from "./models/task";
import { isBlockedByDependencies } from "./models/dependency";
import { getProfile, substituteCommand } from "./profiles";
import { createWorktree, removeWorktree } from "./worktree";
import { isEnabled, FF_ENABLE_KANBAN_DISPATCH } from "./flags";

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

export async function spawnHarness(command: string, cwd: string): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout!.on("data", (data) => { stdout += data.toString(); });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    
    child.on("error", (err) => {
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

function claimTask(id: number): boolean {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'running', updated_at = unixepoch() WHERE id = ? AND status = 'ready' AND archived_at IS NULL`,
    [id]
  );
  return result.changes > 0;
}

function getBoardWorkdir(boardId: number): string | null {
  const db = getDb();
  const board = db.query(
    `SELECT workdir FROM boards WHERE id = ? AND archived_at IS NULL`
  ).get(boardId) as { workdir: string } | undefined;
  return board?.workdir ?? null;
}

function finishTask(id: number, result: string): void {
  const db = getDb();
  db.run(
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, updated_at = unixepoch() WHERE id = ?`,
    [result, result.slice(0, 200), id]
  );
}

function failTask(id: number, result: string, reason: string): void {
  const db = getDb();
  db.run(
    `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, updated_at = unixepoch() WHERE id = ?`,
    [result, reason, id]
  );
}

export async function tick(options: TickOptions = {}): Promise<TickResult> {
  const doSpawnHarness = options.spawnHarness ?? spawnHarness;
  const doCreateWorktree = options.createWorktree ?? createWorktree;
  const doRemoveWorktree = options.removeWorktree ?? removeWorktree;
  
  if (!isEnabled(FF_ENABLE_KANBAN_DISPATCH)) {
    return { processed: 0 };
  }
  
  const tasks = listReadyTasks();
  let processed = 0;
  
  for (const task of tasks) {
    if (isBlockedByDependencies(task.id)) {
      continue;
    }
    
    const claimed = claimTask(task.id);
    if (!claimed) {
      continue;
    }
    
    const workdir = getBoardWorkdir(task.board_id);
    if (!workdir) {
      failTask(task.id, "", "Board not found or archived");
      continue;
    }
    
    let profile;
    try {
      profile = getProfile(task.assignee ?? "opencode");
    } catch {
      failTask(task.id, "", `Unknown profile: ${task.assignee ?? "opencode"}`);
      continue;
    }
    
    let worktreePath: string;
    try {
      worktreePath = doCreateWorktree(workdir, profile.name, String(task.id));
    } catch (err: any) {
      failTask(task.id, "", `Worktree creation failed: ${err.message}`);
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
      
      const { stdout, stderr, exitCode } = await doSpawnHarness(command, worktreePath);
      
      if (exitCode === 0) {
        finishTask(task.id, stdout);
      } else {
        failTask(task.id, stdout, `Harness failed (exit ${exitCode}): ${stderr || "unknown error"}`);
      }
      
      processed++;
    } catch (err: any) {
      failTask(task.id, "", `Harness execution failed: ${err.message}`);
      processed++;
    } finally {
      try {
        doRemoveWorktree(workdir, profile.name, String(task.id));
      } catch {
        // Best effort cleanup
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
      } catch {
        // Log and continue
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
