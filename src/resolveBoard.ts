import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertValidBoardSlug } from "./slugs";

export const CURRENT_BOARD_FILENAME = "current";

/**
 * Return the path to the `current` board file.
 */
export function getCurrentBoardFilePath(): string {
  return join(
    process.env.KDI_CURRENT_PATH ||
      join(process.env.HOME || homedir(), ".local", "share", "kdi"),
    CURRENT_BOARD_FILENAME
  );
}

/**
 * Read the current board slug from the `current` file.
 * Returns `null` when the file does not exist or is empty.
 */
export function readCurrentBoard(): string | null {
  const path = getCurrentBoardFilePath();
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Write `slug` to the `current` board file.
 */
export function writeCurrentBoard(slug: string): void {
  assertValidBoardSlug(slug);
  const path = getCurrentBoardFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${slug}\n`, "utf-8");
}

/**
 * Resolve the effective board slug using the chain:
 *
 *   1. Explicit `--board` flag (highest priority)
 *   2. `KDI_BOARD` environment variable
 *   3. `~/.local/share/kdi/current` file written by `boards switch`
 *   4. `"default"` fallback
 *
 * Returns the resolved slug.
 */
export function resolveBoard(explicitSlug?: string): string {
  // 1. Explicit flag
  if (explicitSlug !== undefined && explicitSlug.trim() !== "") {
    return explicitSlug.trim();
  }

  // 2. Environment variable
  const envSlug = process.env.KDI_BOARD;
  if (envSlug !== undefined && envSlug.trim() !== "") {
    return envSlug.trim();
  }

  // 3. Current board file
  const currentSlug = readCurrentBoard();
  if (currentSlug !== null) {
    return currentSlug;
  }

  // 4. Default fallback
  return "default";
}
