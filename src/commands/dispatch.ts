import { Command } from "commander";
import { startDispatcher } from "../dispatcher";
import { isEnabled, FF_RATE_LIMIT_EXIT_CODE, FF_DISPATCH_CONTROLS } from "../flags";
import { parseDuration } from "../models/task";

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
  .description("Dispatch ready tasks to agents")
  .option("--interval <ms>", "Poll interval in milliseconds", "5000")
  .option("--max <n>", "Max tasks to spawn per tick (0 = unlimited)", "0")
  .option("--rate-limit-cooldown <duration>", "Cooldown after an EX_TEMPFAIL exit code (e.g. 60s, 5m, 1h)")
  .option("--failure-limit <n>", "Stop spawning after N failures/crashes/spawn-fails in this pass")
  .action(async (options: { interval: string; max: string; rateLimitCooldown?: string; failureLimit?: string }) => {
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

    console.log(`Starting dispatcher with ${interval}ms interval...`);
    const dispatcher = startDispatcher(interval, { maxSpawnsPerTick: max > 0 ? max : undefined, rateLimitCooldownSeconds, failureLimit });

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
