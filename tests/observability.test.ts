import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("recordTaskAge buckets values correctly", () => {
    recordTaskAge(30_000);      // 0.5min  -> 0-1min
    recordTaskAge(60_000);      // 1min    -> 0-1min
    recordTaskAge(120_000);     // 2min    -> 1-5min
    recordTaskAge(300_000);     // 5min    -> 1-5min
    recordTaskAge(600_000);     // 10min   -> 5-15min
    recordTaskAge(900_000);     // 15min   -> 5-15min
    recordTaskAge(1_800_000);   // 30min   -> 15-60min
    recordTaskAge(3_600_000);   // 60min   -> 15-60min
    recordTaskAge(3_600_001);   // 60min+  -> 60min+
    const metrics = getMetrics();
    expect(metrics.taskAges["0-1min"]).toBe(2);
    expect(metrics.taskAges["1-5min"]).toBe(2);
    expect(metrics.taskAges["5-15min"]).toBe(2);
    expect(metrics.taskAges["15-60min"]).toBe(2);
    expect(metrics.taskAges["60min+"]).toBe(1);
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
      logToBoard("nested-board", "Nested log");
      const logPath = getLogPath("nested-board");
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

  it("resetMetrics clears all metrics", () => {
    recordTick();
    recordClaim(true);
    recordTaskDuration("opencode", 100);
    recordAgentError("opencode");
    recordTaskAge(30_000);
    resetMetrics();
    const metrics = getMetrics();
    expect(metrics.ticks).toBe(0);
    expect(metrics.claims.success).toBe(0);
    expect(metrics.claims.failure).toBe(0);
    expect(Object.keys(metrics.taskDurations)).toHaveLength(0);
    expect(Object.keys(metrics.agentErrors)).toHaveLength(0);
    expect(metrics.taskAges["0-1min"]).toBe(0);
    expect(metrics.taskAges["1-5min"]).toBe(0);
    expect(metrics.taskAges["5-15min"]).toBe(0);
    expect(metrics.taskAges["15-60min"]).toBe(0);
    expect(metrics.taskAges["60min+"]).toBe(0);
  });

  it("logToBoard rejects path-traversal slugs", () => {
    expect(() => logToBoard("../../etc/passwd", "bad")).toThrow("Invalid boardSlug");
    expect(() => logToBoard("board/../other", "bad")).toThrow("Invalid boardSlug");
  });

  it("logToBoard truncates log when it exceeds 10MB", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-observability-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const logPath = getLogPath("big-board");
      mkdirSync(dirname(logPath), { recursive: true });
      // Pre-fill log to just over 10MB
      writeFileSync(logPath, "x".repeat(10 * 1024 * 1024 + 1));
      logToBoard("big-board", "New message after truncation");
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("New message after truncation");
      expect(content.length).toBeLessThan(1000);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("logToBoard throws on unwritable directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-observability-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      // Make the logs directory unwritable
      const logDir = join(tmpDir, ".local", "share", "kdi", "logs");
      mkdirSync(logDir, { recursive: true });
      chmodSync(logDir, 0o555);
      expect(() => logToBoard("readonly-board", "should fail")).toThrow();
    } finally {
      process.env.HOME = originalHome;
      // Restore permissions so rmSync can clean up
      const logDir = join(tmpDir, ".local", "share", "kdi", "logs");
      try { chmodSync(logDir, 0o755); } catch {}
      rmSync(tmpDir, { recursive: true });
    }
  });
});
