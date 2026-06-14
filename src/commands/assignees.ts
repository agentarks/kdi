import { Command } from "commander";
import { loadProfiles } from "../profiles";
import { getAssigneeCounts } from "../models/task";
import { showBoard } from "../models/board";
import { isEnabled, FF_ASSIGNEES_LISTING } from "../flags";
import { resolveBoard } from "../resolveBoard";

export interface AssigneeRow {
  profile: string;
  count: number;
}

export const assigneesCommand = new Command("assignees")
  .description("List known profiles and per-profile task counts for a board")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--json", "Output as JSON")
  .action((options: { board?: string; json?: boolean }) => {
    try {
      if (!isEnabled(FF_ASSIGNEES_LISTING)) {
        console.error("Assignees listing feature is not enabled.");
        process.exit(1);
      }

      const boardSlug = resolveBoard(options.board);
      const board = showBoard(boardSlug, false);
      if (!board) {
        throw new Error(`Board "${boardSlug}" not found or is archived.`);
      }

      const counts = getAssigneeCounts(board.id);
      const profileNames = loadProfiles().map((profile) => profile.name);
      const assigneesFromBoard = Object.keys(counts);

      const union = new Set([...profileNames, ...assigneesFromBoard]);
      const rows: AssigneeRow[] = Array.from(union)
        .sort((a, b) => a.localeCompare(b))
        .map((profile) => ({ profile, count: counts[profile] ?? 0 }));

      if (options.json) {
        console.log(JSON.stringify({ board: boardSlug, assignees: rows }, null, 2));
        return;
      }

      console.log(`Board: ${boardSlug}`);
      console.log("");
      console.log("Assignees:");
      if (rows.length === 0) {
        console.log("  (none)");
      } else {
        for (const row of rows) {
          console.log(`  ${row.profile}: ${row.count}`);
        }
      }
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
