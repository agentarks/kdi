import { Command } from "commander";
import { createBoard, listBoards, showBoard, archiveBoard } from "../models/board";

export const boardsCommand = new Command("boards")
  .description("Manage kanban boards");

boardsCommand
  .command("create <slug>")
  .description("Create a new board")
  .requiredOption("--workdir <path>", "Working directory for the board")
  .action((slug: string, options: { workdir: string }) => {
    const board = createBoard(slug, options.workdir);
    console.log(`Created board "${board.slug}" with workdir ${board.workdir}`);
  });

boardsCommand
  .command("list")
  .description("List all boards")
  .action(() => {
    const boards = listBoards(true);
    if (boards.length === 0) {
      console.log("No boards.");
      return;
    }
    console.log("Boards:");
    for (const board of boards) {
      const archived = board.archived_at ? " (archived)" : "";
      console.log(`  ${board.slug}  ${board.workdir}${archived}`);
    }
  });

boardsCommand
  .command("show <slug>")
  .description("Show board details and task counts")
  .action((slug: string) => {
    const board = showBoard(slug);
    if (!board) {
      console.error(`Board "${slug}" not found.`);
      process.exit(1);
    }
    console.log(`Board: ${board.slug}`);
    console.log(`Workdir: ${board.workdir}`);
    console.log(`Created: ${new Date(board.created_at * 1000).toISOString()}`);
    console.log("Tasks:");
    console.log(`  todo:     ${board.taskCounts.todo}`);
    console.log(`  ready:    ${board.taskCounts.ready}`);
    console.log(`  running:  ${board.taskCounts.running}`);
    console.log(`  done:     ${board.taskCounts.done}`);
    console.log(`  blocked:  ${board.taskCounts.blocked}`);
  });

boardsCommand
  .command("archive <slug>")
  .description("Archive a board")
  .action((slug: string) => {
    archiveBoard(slug);
    console.log(`Archived board "${slug}".`);
  });
