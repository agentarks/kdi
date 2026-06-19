import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBoardDataDir } from "./db";

/**
 * Resolve the absolute path of the per-board dispatcher PID marker.
 */
export function getDispatcherPidPath(boardSlug: string): string {
  return join(getBoardDataDir(boardSlug), "dispatcher.pid");
}

/**
 * True only when a readable PID file at `<boardDataDir>/dispatcher.pid`
 * contains a single positive integer whose process is alive on this host.
 * Returns false for any error: missing file, unreadable, empty, malformed,
 * zero, negative, or dead PID.
 */
export function isDispatcherPresent(boardSlug: string): boolean {
  try {
    const raw = readFileSync(getDispatcherPidPath(boardSlug), "utf8").trim();
    if (!/^\d+$/.test(raw)) return false;
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
