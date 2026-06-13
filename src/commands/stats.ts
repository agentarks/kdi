import { Command } from "commander";
import { getBoardStats } from "../models/board";
import { isEnabled, FF_STATS } from "../flags";
import { resolveBoard } from "../resolveBoard";

export const statsCommand = new Command("stats")
  .description("Show board statistics")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--json", "Output as JSON")
  .action((options: { board?: string; json?: boolean }) => {
    try {
      if (!isEnabled(FF_STATS)) {
        console.error("Stats feature is not enabled.");
        process.exit(1);
      }

      const boardSlug = resolveBoard(options.board);
      const stats = getBoardStats(boardSlug);

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`Board: ${stats.board}`);
      console.log("");
      console.log("Status counts:");
      for (const [status, count] of Object.entries(stats.status_counts)) {
        console.log(`  ${status}: ${count}`);
      }

      console.log("");
      console.log("Assignee counts:");
      const assigneeEntries = Object.entries(stats.assignee_counts);
      if (assigneeEntries.length === 0) {
        console.log("  (none)");
      } else {
        for (const [assignee, count] of assigneeEntries) {
          console.log(`  ${assignee}: ${count}`);
        }
      }

      console.log("");
      if (stats.oldest_ready_age_seconds === null) {
        console.log("Oldest ready age: (none)");
      } else {
        console.log(`Oldest ready age: ${stats.oldest_ready_age_seconds}s`);
      }
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
