import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

export interface MetricsSnapshot {
  ticks: number;
  claims: { success: number; failure: number };
  taskDurations: Record<string, { count: number; totalMs: number }>;
  agentErrors: Record<string, number>;
  taskAges: Record<string, number>;
}

let ticks = 0;
let claimsSuccess = 0;
let claimsFailure = 0;
const taskDurations: Record<string, { count: number; totalMs: number }> = {};
const agentErrors: Record<string, number> = {};
const taskAges: Record<string, number> = {
  "0-1min": 0,
  "1-5min": 0,
  "5-15min": 0,
  "15-60min": 0,
  "60min+": 0,
};

export function recordTick(): void {
  ticks++;
}

export function recordClaim(success: boolean): void {
  if (success) {
    claimsSuccess++;
  } else {
    claimsFailure++;
  }
}

export function recordTaskDuration(agent: string, durationMs: number): void {
  if (!taskDurations[agent]) {
    taskDurations[agent] = { count: 0, totalMs: 0 };
  }
  taskDurations[agent].count++;
  taskDurations[agent].totalMs += durationMs;
}

export function recordAgentError(agent: string): void {
  if (!agentErrors[agent]) {
    agentErrors[agent] = 0;
  }
  agentErrors[agent]++;
}

export function recordTaskAge(ageMs: number): void {
  const min = ageMs / 60000;
  if (min <= 1) {
    taskAges["0-1min"]++;
  } else if (min <= 5) {
    taskAges["1-5min"]++;
  } else if (min <= 15) {
    taskAges["5-15min"]++;
  } else if (min <= 60) {
    taskAges["15-60min"]++;
  } else {
    taskAges["60min+"]++;
  }
}

export function getMetrics(): MetricsSnapshot {
  return {
    ticks,
    claims: { success: claimsSuccess, failure: claimsFailure },
    taskDurations: { ...taskDurations },
    agentErrors: { ...agentErrors },
    taskAges: { ...taskAges },
  };
}

export function resetMetrics(): void {
  ticks = 0;
  claimsSuccess = 0;
  claimsFailure = 0;
  for (const key of Object.keys(taskDurations)) {
    delete taskDurations[key];
  }
  for (const key of Object.keys(agentErrors)) {
    delete agentErrors[key];
  }
  taskAges["0-1min"] = 0;
  taskAges["1-5min"] = 0;
  taskAges["5-15min"] = 0;
  taskAges["15-60min"] = 0;
  taskAges["60min+"] = 0;
}

export function getLogPath(boardSlug: string): string {
  return join(process.env.HOME || homedir(), ".local", "share", "kdi", "logs", `${boardSlug}.log`);
}

export function getTaskLogPath(boardSlug: string, taskId: number): string {
  if (!SLUG_RE.test(boardSlug)) {
    throw new Error(`Invalid boardSlug: ${boardSlug}`);
  }
  return join(process.env.HOME || homedir(), ".local", "share", "kdi", "logs", boardSlug, `${taskId}.log`);
}

export function logToBoard(boardSlug: string, message: string): void {
  if (!SLUG_RE.test(boardSlug)) {
    throw new Error(`Invalid boardSlug: ${boardSlug}`);
  }
  const logPath = getLogPath(boardSlug);
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true });

  try {
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE) {
      writeFileSync(logPath, "");
    }
  } catch {
    // File does not exist yet, which is fine
  }

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${boardSlug}] ${message}\n`;
  appendFileSync(logPath, line);
}
