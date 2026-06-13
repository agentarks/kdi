import { Command } from "commander";
import { createBoard, listBoards, showBoard, archiveBoard } from "../models/board";
import { assertValidBoardSlug } from "../slugs";

export const boardsCommand = new Command("boards")
  .description("Manage kanban boards");

boardsCommand
  .command("create <slug>")
  .description("Create a new board")
  .requiredOption("--workdir <path>", "Working directory for the board")
  .option("--base-ref <ref>", "Git base ref for worktrees (default: origin/main)", "origin/main")
  .action((slug: string, options: { workdir: string; baseRef: string }) => {
    try {
      assertValidBoardSlug(slug);
      const board = createBoard(slug, options.workdir, options.baseRef);
      console.log(`Created board "${board.slug}" with workdir ${board.workdir} base-ref ${board.base_ref}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("list")
  .description("List all boards")
  .option("--all", "Include archived boards")
  .action((options: { all?: boolean }) => {
    try {
      const boards = listBoards(options.all ?? false);
      if (boards.length === 0) {
        console.log("No boards.");
        return;
      }
      console.log("Boards:");
      for (const board of boards) {
        const archived = board.archived_at ? " (archived)" : "";
        console.log(`  ${board.slug}  ${board.workdir}${archived}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("show <slug>")
  .description("Show board details and task counts")
  .action((slug: string) => {
    try {
      const board = showBoard(slug, true);
      if (!board) {
        console.error(`Board "${slug}" not found.`);
        process.exit(1);
      }
      const archived = board.archived_at ? " (archived)" : "";
      console.log(`Board: ${board.slug}${archived}`);
      console.log(`Workdir: ${board.workdir}`);
      console.log(`Base ref: ${board.base_ref}`);
      console.log(`Created: ${new Date(board.created_at * 1000).toISOString()}`);
      console.log("Tasks:");
      console.log(`  triage:     ${board.taskCounts.triage}`);
      console.log(`  todo:       ${board.taskCounts.todo}`);
      console.log(`  ready:      ${board.taskCounts.ready}`);
      console.log(`  running:    ${board.taskCounts.running}`);
      console.log(`  done:       ${board.taskCounts.done}`);
      console.log(`  blocked:    ${board.taskCounts.blocked}`);
      console.log(`  review:     ${board.taskCounts.review}`);
      console.log(`  scheduled:  ${board.taskCounts.scheduled}`);
      console.log(`  archived:   ${board.taskCounts.archived}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("archive <slug>")
  .description("Archive a board")
  .action((slug: string) => {
    try {
      archiveBoard(slug);
      console.log(`Archived board "${slug}".`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
