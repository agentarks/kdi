import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "./db";
import { TASK_COLUMNS, type Task, promoteScheduledTasks, hydrateTask, showTask } from "./models/task";
import { finishRun, updateRun } from "./models/taskRun";
import { addEvent } from "./models/taskEvent";
import { atomicClaim, heartbeat } from "./models/claim";
import { decrementGoalTurns } from "./models/task";
import { isBlockedByDependencies } from "./models/dependency";
import { getProfile, substituteCommand } from "./profiles";
import { createWorktree, removeWorktree, type RemoveWorktreeResult } from "./worktree";
import { isEnabled, FF_ENABLE_KANBAN_DISPATCH, FF_WORKER_LOG_CAPTURE, FF_CRASH_GRACE_PERIOD, FF_HEARTBEAT, FF_RATE_LIMIT_EXIT_CODE, FF_NOTIFY_SUBS, FF_SWARM_MODE, FF_GOAL_MODE, FF_HARNESS_CONTEXT, FF_RESULT_SUMMARY } from "./flags";
import { extractHarnessResult } from "./harnessResult";

import { runNotifierWatcher, getLastSeenEventId, setLastSeenEventId } from "./notifiers";
import {
  recordTick,
  recordClaim,
  recordTaskDuration,
  recordAgentError,
  recordTaskAge,
  logToBoard,
  getTaskLogPath,
} from "./observability";

export const CRASH_GRACE_PERIOD_SECONDS = 30;

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
  rateLimitCooldownSeconds?: number;
  failureLimit?: number;
  boardId?: number;
  boardSlug?: string;
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
        logStream = createWriteStream(logPath, { flags: "a" });
        logStream.on("error", () => {
          // Swallow stream errors so log-write failures don't fail the task
        });
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

function listReadyTasks(boardId?: number): Task[] {
  const db = getDb();
  let sql = `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = 'ready' AND archived_at IS NULL
     AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())`;
  const params: number[] = [];
  if (boardId !== undefined) {
    sql += ` AND board_id = ?`;
    params.push(boardId);
  }
  sql += ` ORDER BY priority DESC, created_at ASC`;
  const rows = db.query(sql).all(...params) as Task[];
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

function finishTask(task: Task, result: string, runId: number | null, summary?: string): void {
  const db = getDb();
  const storedSummary = summary ?? result.slice(0, 200);
  db.run(
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, consecutive_failures = 0, claim_lock = NULL, claim_expires = NULL, updated_at = unixepoch() WHERE id = ?`,
    [result, storedSummary, task.id]
  );
  if (runId !== null) {
    finishRun(runId, "completed", storedSummary, null, null);
  }
  addEvent(task.id, "finished", { outcome: "completed" }, runId ?? undefined);

  if (isEnabled(FF_SWARM_MODE) && task.swarm_parent_id !== null && task.title.startsWith("synthesize:")) {
    completeSwarmOrchestrator(task.swarm_parent_id, task.id, result);
  }
}

function completeSwarmOrchestrator(orchestratorId: number, synthesizerId: number, result: string): void {
  const db = getDb();
  const summary = result.slice(0, 200);
  const updateResult = db.run(
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, updated_at = unixepoch() WHERE id = ? AND status = 'triage' AND archived_at IS NULL`,
    [result, summary, orchestratorId]
  );
  if (updateResult.changes > 0) {
    addEvent(orchestratorId, "swarm_completed", { synthesizer_id: synthesizerId, result, summary });
  }
}

function checkSwarmFailures(): number {
  if (!isEnabled(FF_SWARM_MODE)) return 0;
  const db = getDb();
  const rows = db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.status = 'triage' AND t.archived_at IS NULL AND EXISTS (SELECT 1 FROM tasks c WHERE c.swarm_parent_id = t.id AND c.archived_at IS NULL AND (c.status = 'blocked' OR c.status = 'archived'))`
  ).all() as Task[];

  let blocked = 0;
  for (const raw of rows) {
    const orchestrator = hydrateTask(raw);
    const child = db.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE swarm_parent_id = ? AND archived_at IS NULL AND (status = 'blocked' OR status = 'archived') ORDER BY updated_at DESC LIMIT 1`
    ).get(orchestrator.id) as Task | undefined;

    if (!child) continue;
    const reason = `Swarm child #${child.id} (${child.title}) is ${child.status}`;
    const updateResult = db.run(
      `UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = unixepoch() WHERE id = ? AND status = 'triage' AND archived_at IS NULL`,
      [reason, orchestrator.id]
    );
    if (updateResult.changes > 0) {
      addEvent(orchestrator.id, "swarm_failed", { child_id: child.id, child_title: child.title, child_status: child.status, reason });
      blocked++;
    }
  }
  return blocked;
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
    `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, consecutive_failures = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, rate_limited_until = NULL, updated_at = unixepoch() WHERE id = ?`,
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
  const updates = ["status = 'ready'", "result = ?", "claim_lock = NULL", "claim_expires = NULL", "started_at = NULL", "rate_limited_until = NULL", "updated_at = unixepoch()"];
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

function handleRateLimit(task: Task, runId: number | null, cooldownSeconds: number, reason: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cooldownUntil = now + cooldownSeconds;
  const errorMessage = `Rate-limited (EX_TEMPFAIL); requeued until ${new Date(cooldownUntil * 1000).toISOString()}`;

  db.run(
    `UPDATE tasks SET status = 'ready', claim_lock = NULL, claim_expires = NULL, started_at = NULL, current_run_id = NULL, rate_limited_until = ?, updated_at = unixepoch() WHERE id = ?`,
    [cooldownUntil, task.id]
  );

  if (runId !== null) {
    finishRun(runId, "reclaimed", null, null, errorMessage);
  }

  addEvent(task.id, "rate_limited", { exit_code: 75, cooldown_until: cooldownUntil, reason }, runId ?? undefined);
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ponytail: v1 judge approximation. A harness that exits 0 is treated as "goal satisfied";
// any non-zero exit is treated as "not satisfied, run another turn". When the real judge
// lands, this helper will spawn task.goal_judge_profile with KDI_GOAL_* env vars and parse
// the verdict from KDI_GOAL_VERDICT_FILE (schema: { verdict: "done"|"continue", ... }).
function isGoalSatisfied(exitCode: number): boolean {
  return exitCode === 0;
}

function handleGoalContinue(task: Task, result: string, runError: string, runId: number | null): void {
  const db = getDb();
  const max = task.goal_max_turns ?? 0;
  const remainingBefore = task.goal_remaining_turns ?? 0;
  const turn = max - remainingBefore + 1;

  const updated = decrementGoalTurns(task.id);
  const remainingAfter = updated.goal_remaining_turns ?? 0;

  if (remainingAfter <= 0) {
    // Exhausted — block the task.
    const reason = "Goal max turns exhausted";
    db.run(
      `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, rate_limited_until = NULL, updated_at = unixepoch() WHERE id = ?`,
      [result, reason, task.id]
    );
    if (runId !== null) {
      finishRun(runId, "blocked", null, null, runError);
    }
    addEvent(task.id, "blocked", { reason, run_error: runError }, runId ?? undefined);
    addEvent(task.id, "goal_turn", { turn, max_turns: max, remaining_after: 0, verdict: "exhausted" }, runId ?? undefined);
    return;
  }

  // Requeue for another turn. Preserve context, reset claim.
  const note = runError ? `[turn ${turn}] ${runError}` : "";
  const newResult = note ? (task.result ? `${task.result}\n${note}` : note) : task.result;
  db.run(
    `UPDATE tasks SET status = 'ready', result = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, current_run_id = NULL, rate_limited_until = NULL, updated_at = unixepoch() WHERE id = ?`,
    [newResult, task.id]
  );
  if (runId !== null) {
    finishRun(runId, "goal_continue", null, null, runError);
  }
  addEvent(task.id, "reclaimed", { reason: "goal continue", run_error: runError }, runId ?? undefined);
  addEvent(task.id, "goal_turn", { turn, max_turns: max, remaining_after: remainingAfter, verdict: "continue" }, runId ?? undefined);
}

function handleCrash(task: Task, reason: string, runId: number | null): void {
  const db = getDb();
  const consecutiveFailures = task.consecutive_failures + 1;
  const hasMaxRetries = task.max_retries !== null && task.max_retries !== undefined;

  if (runId !== null) {
    finishRun(runId, "crashed", null, null, reason);
  }

  if (hasMaxRetries && consecutiveFailures >= task.max_retries!) {
    db.run(
      `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, consecutive_failures = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
      ["", `Circuit breaker: ${consecutiveFailures} consecutive failures`, consecutiveFailures, task.id]
    );
    addEvent(task.id, "blocked", { reason: `Circuit breaker: ${consecutiveFailures} consecutive failures`, run_error: reason, consecutive_failures: consecutiveFailures }, runId ?? undefined);
  } else if (hasMaxRetries) {
    db.run(
      `UPDATE tasks SET status = 'ready', result = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, consecutive_failures = ?, updated_at = unixepoch() WHERE id = ?`,
      [reason, consecutiveFailures, task.id]
    );
    addEvent(task.id, "reclaimed", { reason, consecutive_failures: consecutiveFailures }, runId ?? undefined);
  } else {
    db.run(
      `UPDATE tasks SET status = 'blocked', result = ?, block_reason = ?, consecutive_failures = ?, claim_lock = NULL, claim_expires = NULL, started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
      ["", reason, consecutiveFailures, task.id]
    );
    addEvent(task.id, "blocked", { reason, consecutive_failures: consecutiveFailures }, runId ?? undefined);
  }
}

function checkCrashedRuns(): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let crashes = 0;

  const runs = db.query(
    `SELECT id, task_id, worker_pid, spawned_at FROM task_runs WHERE status = 'running' AND worker_pid IS NOT NULL`
  ).all() as { id: number; task_id: number; worker_pid: number; spawned_at: number | null }[];

  for (const run of runs) {
    const task = showTask(run.task_id);
    if (!task || task.status !== "running") {
      continue;
    }

    if (isEnabled(FF_CRASH_GRACE_PERIOD) && run.spawned_at !== null && (now - run.spawned_at) < CRASH_GRACE_PERIOD_SECONDS) {
      continue;
    }

    if (!isProcessAlive(run.worker_pid)) {
      handleCrash(task, `Worker process died after grace period (PID ${run.worker_pid})`, run.id);
      crashes++;
    }
  }

  return crashes;
}

function reapStaleClaims(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const heartbeatEnabled = isEnabled(FF_HEARTBEAT);
  const oneHourAgo = now - 3600;

  // Build stale condition: always reap by claim_expires; only reap by heartbeat age when enabled
  const staleConditions = ["claim_expires < ?"];
  const params: (number | string)[] = [now];
  if (heartbeatEnabled) {
    staleConditions.push("(last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)");
    params.push(oneHourAgo);
  }

  // Find stale claims and their active runs, preserving enough state to choose the reclaim reason
  const staleTasks = db.query(
    `SELECT id, current_run_id, claim_expires, last_heartbeat_at FROM tasks WHERE status = 'running' AND (${staleConditions.join(" OR ")})`
  ).all(...params) as { id: number; current_run_id: number | null; claim_expires: number | null; last_heartbeat_at: number | null }[];

  for (const stale of staleTasks) {
    const heartbeatStale = heartbeatEnabled && stale.last_heartbeat_at !== null && stale.last_heartbeat_at < oneHourAgo;
    const claimExpired = stale.claim_expires !== null && stale.claim_expires < now;

    let reason: string;
    if (heartbeatStale) {
      reason = "stale heartbeat detected by dispatcher";
    } else if (claimExpired) {
      reason = "stale claim detected by dispatcher";
    } else {
      reason = "stale claim detected by dispatcher";
    }

    if (stale.current_run_id) {
      finishRun(stale.current_run_id, "reclaimed", null, null, reason);
    }
    addEvent(stale.id, "reclaimed", { reason });

    db.run(
      `UPDATE tasks SET status = 'ready', started_at = NULL, claim_lock = NULL, claim_expires = NULL, current_run_id = NULL, rate_limited_until = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'running'`,
      [stale.id]
    );
  }
}

function getRateLimitCooldownSeconds(options: TickOptions): number {
  if (options.rateLimitCooldownSeconds !== undefined) {
    return options.rateLimitCooldownSeconds;
  }
  const env = process.env.KDI_RATE_LIMIT_COOLDOWN_SECONDS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60;
}

export async function tick(options: TickOptions = {}): Promise<TickResult> {
  const doSpawnHarness = options.spawnHarness ?? spawnHarness;
  const doCreateWorktree = options.createWorktree ?? createWorktree;
  const doRemoveWorktree = options.removeWorktree ?? removeWorktree;
  const maxSpawns = options.maxSpawnsPerTick ?? Infinity;
  const rateLimitCooldownSeconds = getRateLimitCooldownSeconds(options);

  recordTick();

  if (!isEnabled(FF_ENABLE_KANBAN_DISPATCH)) {
    return { processed: 0 };
  }

  reapStaleClaims();
  promoteScheduledTasks(Math.floor(Date.now() / 1000));
  const crashCount = checkCrashedRuns();
  checkSwarmFailures();

  const tasks = listReadyTasks(options.boardId);
  let processed = 0;
  let spawned = 0;
  let failuresThisPass = crashCount;
  const failureLimit = options.failureLimit;

  for (const task of tasks) {
    if (spawned >= maxSpawns) {
      break;
    }

    if (failureLimit !== undefined && failuresThisPass >= failureLimit) {
      const warning = `Dispatcher stopped spawning: failure limit of ${failureLimit} reached this pass.`;
      console.warn(warning);
      // Log to board if we can resolve a slug
      if (tasks.length > 0) {
        const firstBoardSlug = getBoardSlug(tasks[0].board_id);
        if (firstBoardSlug) {
          logToBoard(firstBoardSlug, warning);
        }
      }
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

    // Seed initial heartbeat so a freshly claimed task is not instantly considered stale
    if (isEnabled(FF_HEARTBEAT)) {
      heartbeat(task.id);
    }

    const workdir = task.workspace ?? getBoardWorkdir(task.board_id);
    if (!workdir) {
      handleFailure(task, "", "Board not found or archived", runId);
      spawned++;
      failuresThisPass++;
      continue;
    }

    const baseRef = getBoardBaseRef(task.board_id) ?? "origin/main";

    let profile;
    try {
      profile = getProfile(task.assignee ?? "opencode");
    } catch {
      handleFailure(task, "", `Unknown profile: ${task.assignee ?? "opencode"}`, runId);
      spawned++;
      failuresThisPass++;
      continue;
    }

    const worktreeBranch = `wt/${profile.name}/${task.id}`;

    let worktreePath: string;
    try {
      worktreePath = doCreateWorktree(workdir, profile.name, String(task.id), baseRef);
    } catch (err: any) {
      handleFailure(task, "", `Worktree creation failed: ${err.message}`, runId);
      spawned++;
      failuresThisPass++;
      continue;
    }

    const boardSlug = getBoardSlug(task.board_id);
    const logPath = boardSlug && isEnabled(FF_WORKER_LOG_CAPTURE) ? getTaskLogPath(boardSlug, task.id) : undefined;

    try {
      const skillsValue = task.skills && task.skills.length > 0 ? task.skills.join(",") : "";
      const modelValue = task.model_override ?? "";
      const stepKey = task.current_step_key ?? "";
      const taskContextEnabled = isEnabled(FF_HARNESS_CONTEXT);
      const resultFile = `${worktreePath}/.kdi-result.txt`;
      const command = substituteCommand(profile.command, {
        workdir: worktreePath,
        branch: worktreeBranch,
        task_id: String(task.id),
        agent: profile.agent ?? profile.name,
        skills: skillsValue,
        model: modelValue,
        step_key: stepKey,
        title: taskContextEnabled ? task.title : "",
        body: taskContextEnabled ? (task.body ?? "") : "",
        ...(isEnabled(FF_RESULT_SUMMARY) ? { result_file: resultFile } : {}),
      });

      const harnessEnv: Record<string, string> | undefined = {};
      // KDI-052: pass task context to the harness when enabled.
      if (taskContextEnabled) {
        harnessEnv.KDI_TASK_TITLE = task.title;
        harnessEnv.KDI_TASK_BODY = task.body ?? "";
        harnessEnv.KDI_TASK_ID = String(task.id);
        harnessEnv.KDI_BOARD = boardSlug ?? "";
      }
      if (skillsValue) harnessEnv.KDI_SKILLS = skillsValue;
      if (modelValue) harnessEnv.KDI_MODEL = modelValue;
      if (stepKey) harnessEnv.KDI_CURRENT_STEP_KEY = stepKey;
      if (isEnabled(FF_RESULT_SUMMARY)) {
        harnessEnv.KDI_RESULT_FILE = resultFile;
      }

      // KDI-038: pass goal-mode context to the harness so it knows which turn this is,
      // how many turns remain, and where the judge can write its verdict.
      if (isEnabled(FF_GOAL_MODE) && task.goal_mode) {
        const goalMax = task.goal_max_turns ?? 0;
        const goalRemaining = task.goal_remaining_turns ?? 0;
        const goalTurn = Math.max(1, goalMax - goalRemaining + 1);
        harnessEnv.KDI_GOAL_MODE = "true";
        harnessEnv.KDI_GOAL_MAX_TURNS = String(goalMax);
        harnessEnv.KDI_GOAL_REMAINING_TURNS = String(goalRemaining);
        harnessEnv.KDI_GOAL_TURN = String(goalTurn);
        harnessEnv.KDI_GOAL_CONTEXT = task.result ?? "";
        harnessEnv.KDI_GOAL_VERDICT_FILE = `${worktreePath}/.kdi-goal-verdict.json`;
      }
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

      // KDI-038: goal-mode overrides the normal single-turn outcomes.
      // v1 approximation: harness exit 0 = goal satisfied; any non-zero exit = not satisfied.
      if (isEnabled(FF_GOAL_MODE) && task.goal_mode) {
        if (isGoalSatisfied(exitCode)) {
          const goalMax = task.goal_max_turns ?? 0;
          const goalRemaining = task.goal_remaining_turns ?? 0;
          const goalTurn = goalMax - goalRemaining + 1;
          addEvent(task.id, "goal_turn", { turn: goalTurn, max_turns: goalMax, remaining_after: goalRemaining, verdict: "done" }, runId ?? undefined);
          const { result, summary } = isEnabled(FF_RESULT_SUMMARY)
            ? extractHarnessResult(worktreePath, harnessResult.stdout)
            : { result: harnessResult.stdout, summary: harnessResult.stdout.slice(0, 200) };
          finishTask(task, result, runId, summary);
          processed++;
        } else {
          recordAgentError(profile.agent ?? profile.name);
          handleGoalContinue(task, stdout, `Harness failed (exit ${exitCode}): ${stderr || "unknown error"}`, runId);
          failuresThisPass++;
        }
        spawned++;
        continue;
      }

      if (exitCode === 0) {
        const { result, summary } = isEnabled(FF_RESULT_SUMMARY)
          ? extractHarnessResult(worktreePath, harnessResult.stdout)
          : { result: harnessResult.stdout, summary: harnessResult.stdout.slice(0, 200) };
        finishTask(task, result, runId, summary);
        processed++;
      } else if (exitCode === 75 && isEnabled(FF_RATE_LIMIT_EXIT_CODE)) {
        handleRateLimit(task, runId, rateLimitCooldownSeconds, stderr || stdout);
      } else {
        recordAgentError(profile.agent ?? profile.name);
        handleFailure(task, stdout, `Harness failed (exit ${exitCode}): ${stderr || "unknown error"}`, runId);
        failuresThisPass++;
      }

      spawned++;
    } catch (err: any) {
      recordAgentError(profile.agent ?? profile.name);
      handleFailure(task, "", `Harness execution failed: ${err.message}`, runId);
      spawned++;
      failuresThisPass++;
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

  if (isEnabled(FF_NOTIFY_SUBS)) {
    const db = getDb();
    const boardSlugs = db.query(
      `SELECT DISTINCT b.slug
       FROM kanban_notify_subs s
       JOIN tasks t ON t.id = s.task_id
       JOIN boards b ON b.id = t.board_id
       WHERE s.unsubscribed_at IS NULL AND t.archived_at IS NULL`
    ).all() as { slug: string }[];

    for (const { slug } of boardSlugs) {
      try {
        const lastSeen = getLastSeenEventId(slug);
        const newLastSeen = await runNotifierWatcher(slug, lastSeen);
        setLastSeenEventId(slug, newLastSeen);
      } catch (err) {
        console.warn(`Notifier watcher failed for board ${slug}:`, err);
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
