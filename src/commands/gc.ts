import { Command } from "commander";
import { runGarbageCollection } from "../models/gc";
import { isEnabled, FF_GC } from "../flags";
import { resolveBoard } from "../resolveBoard";

export const gcCommand = new Command("gc")
  .description("Garbage collection: prune old events, logs, and archived task workspaces")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--event-retention-days <n>", "Delete task events older than N days")
  .option("--log-retention-days <n>", "Delete worker logs older than N days")
  .action((options: { board?: string; eventRetentionDays?: string; logRetentionDays?: string }) => {
    try {
      if (!isEnabled(FF_GC)) {
        console.error("GC feature is not enabled.");
        process.exit(1);
      }

      const eventRetentionDays = options.eventRetentionDays !== undefined
        ? parseInt(options.eventRetentionDays, 10)
        : undefined;
      const logRetentionDays = options.logRetentionDays !== undefined
        ? parseInt(options.logRetentionDays, 10)
        : undefined;

      if (eventRetentionDays !== undefined && (isNaN(eventRetentionDays) || eventRetentionDays <= 0)) {
        throw new Error("--event-retention-days must be a positive integer.");
      }
      if (logRetentionDays !== undefined && (isNaN(logRetentionDays) || logRetentionDays <= 0)) {
        throw new Error("--log-retention-days must be a positive integer.");
      }

      const boardSlug = resolveBoard(options.board);
      const result = runGarbageCollection(boardSlug, { eventRetentionDays, logRetentionDays });

      console.log(`Garbage collection complete for board ${result.board}.`);
      console.log(`  Deleted events: ${result.deletedEvents}`);
      console.log(`  Deleted logs: ${result.deletedLogs}`);
      console.log(`  Cleaned archived workspaces: ${result.cleanedWorkspaces}`);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
