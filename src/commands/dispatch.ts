import { Command } from "commander";
import { startDispatcher, tick } from "../dispatcher";
import { isEnabled, FF_RATE_LIMIT_EXIT_CODE, FF_DISPATCH_CONTROLS, FF_DISPATCH_ONCE } from "../flags";
import { parseDuration } from "../models/task";
import { resolveBoard } from "../resolveBoard";
import { showBoard } from "../models/board";

export function parseFailureLimit(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --failure-limit. Must be a positive integer, got "${raw}"`);
  }
  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new Error(`Invalid --failure-limit. Must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export const dispatchCommand = new Command("dispatch")
  .description("Dispatch ready tasks to agents (one-shot pass with --once, daemon otherwise)")
  .option("--interval <ms>", "Poll interval in milliseconds (ignored with --once)", "5000")
  .option("--max <n>", "Max tasks to spawn per tick (0 = unlimited)", "0")
  .option("--once", "Run a single dispatcher tick and exit (hermes 'dispatch' parity)")
  .option("--rate-limit-cooldown <duration>", "Cooldown after an EX_TEMPFAIL exit code (e.g. 60s, 5m, 1h)")
  .option("--failure-limit <n>", "Stop spawning after N failures/crashes/spawn-fails in this pass")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .action(async (options: { interval: string; max: string; once?: boolean; rateLimitCooldown?: string; failureLimit?: string; board?: string }) => {
    const interval = parseInt(options.interval, 10);
    const max = parseInt(options.max, 10);

    if (isNaN(interval) || interval <= 0) {
      console.error("Invalid interval. Must be a positive number.");
      process.exit(1);
    }

    if (isNaN(max) || max < 0) {
      console.error("Invalid max. Must be a non-negative number.");
      process.exit(1);
    }

    let rateLimitCooldownSeconds: number | undefined;
    if (options.rateLimitCooldown !== undefined) {
      if (!isEnabled(FF_RATE_LIMIT_EXIT_CODE)) {
        console.error("Rate-limit exit code handling is not enabled.");
        process.exit(1);
      }
      rateLimitCooldownSeconds = parseDuration(options.rateLimitCooldown);
    }

    let failureLimit: number | undefined;
    if (options.failureLimit !== undefined) {
      if (!isEnabled(FF_DISPATCH_CONTROLS)) {
        console.error("Dispatch controls feature is not enabled.");
        process.exit(1);
      }
      failureLimit = parseFailureLimit(options.failureLimit);
    }

    const explicitBoard = options.board ?? process.env.KDI_BOARD;
    let boardId: number | undefined;
    let boardSlug: string | undefined;
    if (explicitBoard) {
      boardSlug = resolveBoard(explicitBoard);
      const board = showBoard(boardSlug, false);
      if (!board) {
        console.error(`Board "${boardSlug}" not found or is archived.`);
        process.exit(1);
      }
      boardId = board.id;
    }

    const tickOptions = {
      maxSpawnsPerTick: max > 0 ? max : undefined,
      rateLimitCooldownSeconds,
      failureLimit,
      boardId,
      boardSlug,
    };

    if (options.once) {
      if (!isEnabled(FF_DISPATCH_ONCE)) {
        console.error("Error: --once is not enabled. Set FF_DISPATCH_ONCE=true to use it.");
        process.exit(1);
      }
      const result = await tick(tickOptions);
      console.log(`Dispatched (one-shot). processed=${result.processed}`);
      return;
    }

    console.log(`Starting dispatcher with ${interval}ms interval...`);
    const dispatcher = startDispatcher(interval, tickOptions);

    process.on("SIGINT", () => {
      console.log("\nStopping dispatcher...");
      dispatcher.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      dispatcher.stop();
      process.exit(0);
    });
  });
