import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RESULT_FILE_NAME = ".kdi-result.txt";
const SUMMARY_MAX_LEN = 200;
const TEXT_FIELDS = ["content", "text", "output", "message", "result"] as const;

/**
 * Extract a clean human-readable result/summary from harness output.
 *
 * Priority:
 * 1. `<worktreePath>/.kdi-result.txt` if it exists.
 * 2. The last JSON object on a line in stdout that has a known text field.
 * 3. Raw stdout as a fallback.
 *
 * This function is defensive: it never throws. Any error falls back to stdout.
 */
export function extractHarnessResult(
  worktreePath: string,
  stdout: string
): { result: string; summary: string } {
  try {
    const resultFile = join(worktreePath, RESULT_FILE_NAME);
    if (existsSync(resultFile)) {
      const result = readFileSync(resultFile, "utf-8").trim();
      return { result, summary: result.slice(0, SUMMARY_MAX_LEN) };
    }
  } catch {
    // Fall through to stdout parsing.
  }

  try {
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      for (const field of TEXT_FIELDS) {
        const value = record[field];
        if (typeof value === "string") {
          const result = value.trim();
          return { result, summary: result.slice(0, SUMMARY_MAX_LEN) };
        }
      }
    }
  } catch {
    // Fall through to raw stdout.
  }

  const result = stdout.trim();
  return { result, summary: result.slice(0, SUMMARY_MAX_LEN) };
}
