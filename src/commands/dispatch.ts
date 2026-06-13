import { Command } from "commander";
import { startDispatcher } from "../dispatcher";
import { isEnabled, FF_RATE_LIMIT_EXIT_CODE } from "../flags";
import { parseDuration } from "../models/task";

export const dispatchCommand = new Command("dispatch")
  .description("Dispatch ready tasks to agents")
  .option("--interval <ms>", "Poll interval in milliseconds", "5000")
  .option("--max <n>", "Max tasks to spawn per tick (0 = unlimited)", "0")
  .option("--rate-limit-cooldown <duration>", "Cooldown after an EX_TEMPFAIL exit code (e.g. 60s, 5m, 1h)")
  .action(async (options: { interval: string; max: string; rateLimitCooldown?: string }) => {
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

    console.log(`Starting dispatcher with ${interval}ms interval...`);
    const dispatcher = startDispatcher(interval, { maxSpawnsPerTick: max > 0 ? max : undefined, rateLimitCooldownSeconds });

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
