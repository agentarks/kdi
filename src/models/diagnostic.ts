import { getDb } from "../db";
import { showBoard } from "./board";
import { TASK_COLUMNS, hydrateTask, type Task } from "./task";

export type DiagnosticSeverity = "warning" | "error" | "critical";

export type DiagnosticAction =
  | "reclaim"
  | "reassign"
  | "unblock"
  | "cli_hint"
  | "open_docs"
  | "comment";

export interface DiagnosticFinding {
  rule: string;
  severity: DiagnosticSeverity;
  task_id: number;
  message: string;
  actions: DiagnosticAction[];
}

export interface DiagnosticsOptions {
  taskId?: number;
  severity?: DiagnosticSeverity;
}

const THRESHOLDS = {
  ready_age_seconds: 24 * 60 * 60,
  blocked_age_seconds: 24 * 60 * 60,
  triage_age_seconds: 60 * 60,
  consecutive_failures: 3,
  crashed_runs: 3,
  block_unblock_cycles: 3,
};

const WINDOW_LIMITS = {
  events_per_task: 100,
  runs_per_task: 100,
};

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  warning: 1,
  error: 2,
  critical: 3,
};

function finding(
  rule: string,
  severity: DiagnosticSeverity,
  taskId: number,
  message: string,
  actions: DiagnosticAction[]
): DiagnosticFinding {
  return { rule, severity, task_id: taskId, message, actions };
}

function exceedsSeverity(minimum: DiagnosticSeverity, actual: DiagnosticSeverity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[minimum];
}

function getTasksForBoard(boardId: number, taskId?: number): Task[] {
  const db = getDb();
  if (taskId !== undefined) {
    const task = db.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND board_id = ? AND archived_at IS NULL`
    ).get(taskId, boardId) as Task | undefined;
    return task ? [hydrateTask(task)] : [];
  }

  const tasks = db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? AND archived_at IS NULL`
  ).all(boardId) as Task[];
  return tasks.map(hydrateTask);
}

function ruleStrandedInReady(tasks: Task[], now: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    if (task.status !== "ready") continue;
    const age = now - task.created_at;
    if (age > THRESHOLDS.ready_age_seconds) {
      findings.push(
        finding(
          "stranded_in_ready",
          "warning",
          task.id,
          `Task has been ready for ${age}s (threshold ${THRESHOLDS.ready_age_seconds}s).`,
          ["cli_hint", "reassign", "comment"]
        )
      );
    }
  }
  return findings;
}

function ruleStuckInBlocked(tasks: Task[], now: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    if (task.status !== "blocked") continue;
    const age = now - task.created_at;
    if (age > THRESHOLDS.blocked_age_seconds) {
      findings.push(
        finding(
          "stuck_in_blocked",
          "warning",
          task.id,
          `Task has been blocked for ${age}s (threshold ${THRESHOLDS.blocked_age_seconds}s).`,
          ["unblock", "comment", "cli_hint"]
        )
      );
    }
  }
  return findings;
}

function ruleRepeatedFailures(tasks: Task[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    if (task.consecutive_failures >= THRESHOLDS.consecutive_failures) {
      findings.push(
        finding(
          "repeated_failures",
          "error",
          task.id,
          `Task has ${task.consecutive_failures} consecutive failures (threshold ${THRESHOLDS.consecutive_failures}).`,
          ["reclaim", "reassign", "comment", "cli_hint"]
        )
      );
    }
  }
  return findings;
}

function ruleRepeatedCrashes(tasks: Task[]): DiagnosticFinding[] {
  if (tasks.length === 0) return [];
  const db = getDb();
  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => "?").join(",");

  const rows = db.query(
    `SELECT task_id, COUNT(*) AS count
     FROM task_runs
     WHERE task_id IN (${placeholders}) AND outcome = 'crashed'
     GROUP BY task_id`
  ).all(...taskIds) as { task_id: number; count: number }[];

  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(row.task_id, Number(row.count));
  }

  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    const count = counts.get(task.id) ?? 0;
    if (count >= THRESHOLDS.crashed_runs) {
      findings.push(
        finding(
          "repeated_crashes",
          "error",
          task.id,
          `Task has ${count} crashed runs (threshold ${THRESHOLDS.crashed_runs}).`,
          ["reclaim", "reassign", "comment", "open_docs"]
        )
      );
    }
  }
  return findings;
}

function ruleBlockUnblockCycling(tasks: Task[]): DiagnosticFinding[] {
  if (tasks.length === 0) return [];
  const db = getDb();
  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => "?").join(",");

  const rows = db.query(
    `SELECT task_id, kind
     FROM task_events
     WHERE task_id IN (${placeholders}) AND kind IN ('blocked', 'unblocked')
     ORDER BY created_at ASC
     LIMIT ?`
  ).all(...taskIds, tasks.length * WINDOW_LIMITS.events_per_task) as {
    task_id: number;
    kind: string;
  }[];

  const counts = new Map<number, { blocked: number; unblocked: number }>();
  for (const row of rows) {
    const current = counts.get(row.task_id) ?? { blocked: 0, unblocked: 0 };
    if (row.kind === "blocked") current.blocked++;
    if (row.kind === "unblocked") current.unblocked++;
    counts.set(row.task_id, current);
  }

  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    const { blocked, unblocked } = counts.get(task.id) ?? { blocked: 0, unblocked: 0 };
    const cycles = Math.min(blocked, unblocked);
    if (cycles >= THRESHOLDS.block_unblock_cycles) {
      findings.push(
        finding(
          "block_unblock_cycling",
          "warning",
          task.id,
          `Task has ${cycles} block/unblock cycles (threshold ${THRESHOLDS.block_unblock_cycles}).`,
          ["comment", "cli_hint", "reassign"]
        )
      );
    }
  }
  return findings;
}

const TASK_REF_REGEX = /#(\d+)/g;

function extractTaskRefs(body: string | null): number[] {
  if (!body) return [];
  const refs = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = TASK_REF_REGEX.exec(body)) !== null) {
    refs.add(Number(match[1]));
  }
  return Array.from(refs);
}

interface RefLookup {
  refId: number;
  taskId: number;
}

function collectTaskRefs(tasks: Task[]): RefLookup[] {
  const lookups: RefLookup[] = [];
  for (const task of tasks) {
    for (const refId of extractTaskRefs(task.body)) {
      lookups.push({ refId, taskId: task.id });
    }
  }
  return lookups;
}

function ruleTaskRefs(tasks: Task[], boardId: number): DiagnosticFinding[] {
  const db = getDb();
  const lookups = collectTaskRefs(tasks);
  if (lookups.length === 0) return [];

  const refIds = Array.from(new Set(lookups.map((l) => l.refId)));
  const placeholders = refIds.map(() => "?").join(",");
  const rows = db.query(
    `SELECT id, board_id, archived_at FROM tasks WHERE id IN (${placeholders})`
  ).all(...refIds) as { id: number; board_id: number; archived_at: number | null }[];

  const refs = new Map<number, { board_id: number; archived_at: number | null }>();
  for (const row of rows) {
    refs.set(row.id, { board_id: row.board_id, archived_at: row.archived_at });
  }

  const hallucinatedFindings = new Map<string, DiagnosticFinding>();
  const phantomFindings = new Map<string, DiagnosticFinding>();

  for (const { refId, taskId } of lookups) {
    const ref = refs.get(refId);
    const key = `${taskId}:${refId}`;

    if (!ref || ref.archived_at !== null) {
      hallucinatedFindings.set(
        key,
        finding(
          "hallucinated_cards",
          "warning",
          taskId,
          `Task body references task #${refId} which does not exist or is archived on this board.`,
          ["comment", "cli_hint"]
        )
      );
    } else if (ref.board_id !== boardId) {
      phantomFindings.set(
        key,
        finding(
          "prose_phantom_refs",
          "warning",
          taskId,
          `Task body references task #${refId} which belongs to a different board.`,
          ["comment", "cli_hint"]
        )
      );
    }
  }

  return [...hallucinatedFindings.values(), ...phantomFindings.values()];
}

function ruleTriageAuxUnavailable(tasks: Task[], now: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const task of tasks) {
    if (task.status !== "triage") continue;
    const age = now - task.created_at;
    if (age > THRESHOLDS.triage_age_seconds && (!task.body || !task.assignee)) {
      const missing: string[] = [];
      if (!task.body) missing.push("a body");
      if (!task.assignee) missing.push("an assignee");
      findings.push(
        finding(
          "triage_aux_unavailable",
          "warning",
          task.id,
          `Triage task has been unprocessed for ${age}s and lacks ${missing.join(" and ")}.`,
          ["comment", "cli_hint", "reassign"]
        )
      );
    }
  }
  return findings;
}

export function runDiagnostics(
  boardSlug: string,
  options: DiagnosticsOptions = {}
): DiagnosticFinding[] {
  const board = showBoard(boardSlug, false);
  if (!board) {
    throw new Error(`Board "${boardSlug}" not found or is archived.`);
  }

  if (options.taskId !== undefined) {
    const db = getDb();
    const task = db.query(
      `SELECT id FROM tasks WHERE id = ? AND board_id = ? AND archived_at IS NULL`
    ).get(options.taskId, board.id) as { id: number } | undefined;
    if (!task) {
      throw new Error(`Task ${options.taskId} not found on board "${boardSlug}".`);
    }
  }

  const tasks = getTasksForBoard(board.id, options.taskId);
  const now = Math.floor(Date.now() / 1000);

  let findings: DiagnosticFinding[] = [
    ...ruleStrandedInReady(tasks, now),
    ...ruleStuckInBlocked(tasks, now),
    ...ruleRepeatedFailures(tasks),
    ...ruleRepeatedCrashes(tasks),
    ...ruleBlockUnblockCycling(tasks),
    ...ruleTaskRefs(tasks, board.id),
    ...ruleTriageAuxUnavailable(tasks, now),
  ];

  const minimumSeverity = options.severity;
  if (minimumSeverity) {
    findings = findings.filter((f) => exceedsSeverity(minimumSeverity, f.severity));
  }

  findings.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.task_id - b.task_id || a.rule.localeCompare(b.rule);
  });

  return findings;
}
