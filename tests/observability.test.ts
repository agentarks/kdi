import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordTick,
  recordClaim,
  recordTaskDuration,
  recordAgentError,
  recordTaskAge,
  getMetrics,
  getLogPath,
  logToBoard,
  resetMetrics,
} from "../src/observability";

describe("observability", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("recordTick increments tick counter", () => {
    recordTick();
    recordTick();
    const metrics = getMetrics();
    expect(metrics.ticks).toBe(2);
  });

  it("recordClaim tracks success and failure", () => {
    recordClaim(true);
    recordClaim(true);
    recordClaim(false);
    const metrics = getMetrics();
    expect(metrics.claims.success).toBe(2);
    expect(metrics.claims.failure).toBe(1);
  });

  it("recordTaskDuration tracks per-agent durations", () => {
    recordTaskDuration("opencode", 100);
    recordTaskDuration("opencode", 200);
    recordTaskDuration("claude", 150);
    const metrics = getMetrics();
    expect(metrics.taskDurations["opencode"].count).toBe(2);
    expect(metrics.taskDurations["opencode"].totalMs).toBe(300);
    expect(metrics.taskDurations["claude"].count).toBe(1);
    expect(metrics.taskDurations["claude"].totalMs).toBe(150);
  });

  it("recordAgentError tracks per-agent errors", () => {
    recordAgentError("opencode");
    recordAgentError("opencode");
    recordAgentError("claude");
    const metrics = getMetrics();
    expect(metrics.agentErrors["opencode"]).toBe(2);
    expect(metrics.agentErrors["claude"]).toBe(1);
  });

  it("recordTaskAge keeps last 1000 values", () => {
    for (let i = 0; i < 1005; i++) {
      recordTaskAge(i);
    }
    const metrics = getMetrics();
    expect(metrics.taskAges).toHaveLength(1000);
    expect(metrics.taskAges[0]).toBe(5);
    expect(metrics.taskAges[999]).toBe(1004);
  });

  it("getLogPath returns correct path", () => {
    const path = getLogPath("my-board");
    expect(path).toContain(".local/share/kdi/logs/my-board.log");
  });

  it("logToBoard appends message to log file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-observability-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      logToBoard("test-board", "Task completed successfully");
      const logPath = getLogPath("test-board");
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("Task completed successfully");
      expect(content).toContain("test-board");
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("logToBoard creates directories if needed", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-observability-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      logToBoard("deep/nested/board", "Nested log");
      const logPath = getLogPath("deep/nested/board");
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("Nested log");
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("getMetrics returns independent snapshot", () => {
    recordTick();
    const metrics1 = getMetrics();
    recordTick();
    const metrics2 = getMetrics();
    expect(metrics1.ticks).toBe(1);
    expect(metrics2.ticks).toBe(2);
  });
});
