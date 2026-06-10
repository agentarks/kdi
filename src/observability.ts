import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MetricsSnapshot {
  ticks: number;
  claims: { success: number; failure: number };
  taskDurations: Record<string, { count: number; totalMs: number }>;
  agentErrors: Record<string, number>;
  taskAges: number[];
}

let ticks = 0;
let claimsSuccess = 0;
let claimsFailure = 0;
const taskDurations: Record<string, { count: number; totalMs: number }> = {};
const agentErrors: Record<string, number> = {};
const taskAges: number[] = [];

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
  taskAges.push(ageMs);
  if (taskAges.length > 1000) {
    taskAges.shift();
  }
}

export function getMetrics(): MetricsSnapshot {
  return {
    ticks,
    claims: { success: claimsSuccess, failure: claimsFailure },
    taskDurations: { ...taskDurations },
    agentErrors: { ...agentErrors },
    taskAges: [...taskAges],
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
  taskAges.length = 0;
}

export function getLogPath(boardSlug: string): string {
  return join(homedir(), ".local", "share", "kdi", "logs", `${boardSlug}.log`);
}

export function logToBoard(boardSlug: string, message: string): void {
  const logPath = getLogPath(boardSlug);
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${boardSlug}] ${message}\n`;
  appendFileSync(logPath, line);
}
