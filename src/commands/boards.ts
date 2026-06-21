import { Command } from "commander";
import { createBoard, listBoards, showBoard, archiveBoard, updateBoardMetadata, removeBoard, renameBoard, setDefaultWorkdir } from "../models/board";
import { isEnabled, FF_BOARD_METADATA, FF_BOARD_RM_DELETE, FF_BOARD_SWITCH, FF_BOARD_CREATE_SWITCH, FF_BOARD_RENAME, FF_DEFAULT_WORKDIR } from "../flags";
import { assertValidBoardSlug } from "../slugs";
import { readCurrentBoard, writeCurrentBoard, resolveBoard } from "../resolveBoard";

export const boardsCommand = new Command("boards")
  .description("Manage kanban boards");

boardsCommand
  .command("create <slug>")
  .description("Create a new board")
  .requiredOption("--workdir <path>", "Working directory for the board")
  .option("--base-ref <ref>", "Git base ref for worktrees (default: origin/main)", "origin/main")
  .option("--name <name>", "Display name for the board")
  .option("--icon <icon>", "Icon for the board")
  .option("--color <color>", "Color for the board")
  .option("--switch", "Switch to this board after creation")
  .action((slug: string, options: { workdir: string; baseRef: string; name?: string; icon?: string; color?: string; switch?: boolean }) => {
    try {
      assertValidBoardSlug(slug);
      const metadataRequested = options.name !== undefined || options.icon !== undefined || options.color !== undefined;
      if (metadataRequested && !isEnabled(FF_BOARD_METADATA)) {
        throw new Error("Board metadata feature is not enabled.");
      }
      if (options.switch && !isEnabled(FF_BOARD_CREATE_SWITCH)) {
        throw new Error("Board create --switch feature is not enabled.");
      }

      const metadata = metadataRequested
        ? { name: options.name, icon: options.icon, color: options.color }
        : {};
      const board = createBoard(slug, options.workdir, options.baseRef, metadata);
      if (options.switch) {
        writeCurrentBoard(slug);
      }
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
        const metadataParts: string[] = [];
        if (isEnabled(FF_BOARD_METADATA)) {
          if (board.icon) metadataParts.push(`icon=${board.icon}`);
          if (board.color) metadataParts.push(`color=${board.color}`);
        }
        const metadata = metadataParts.length > 0 ? ` (${metadataParts.join(", ")})` : "";
        console.log(`  ${board.slug}: ${board.name}${metadata}${archived}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("switch <slug>")
  .description("Switch the current board")
  .action((slug: string) => {
    try {
      if (!isEnabled(FF_BOARD_SWITCH)) {
        throw new Error("Board switch feature is not enabled.");
      }
      assertValidBoardSlug(slug);
      const board = showBoard(slug, true);
      if (!board) {
        console.error(`Board "${slug}" not found.`);
        process.exit(1);
      }
      writeCurrentBoard(slug);
      console.log(`Switched to board "${slug}".`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("show [slug]")
  .description("Show board details and task counts (uses current board when slug omitted)")
  .action((slug?: string) => {
    try {
      const effectiveSlug = slug ?? resolveBoard();
      const board = showBoard(effectiveSlug, true);
      if (!board) {
        console.error(`Board "${effectiveSlug}" not found.`);
        process.exit(1);
      }
      const archived = board.archived_at ? " (archived)" : "";
      console.log(`Board: ${board.slug}${archived}`);
      console.log(`Name: ${board.name}`);
      if (isEnabled(FF_BOARD_METADATA)) {
        if (board.icon) console.log(`Icon: ${board.icon}`);
        if (board.color) console.log(`Color: ${board.color}`);
      }
      console.log(`Workdir: ${board.workdir}`);
      if (isEnabled(FF_DEFAULT_WORKDIR) && board.default_workdir) {
        console.log(`Default workdir: ${board.default_workdir}`);
      }
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
  .command("edit <slug>")
  .description("Edit board metadata")
  .option("--name <name>", "Display name for the board")
  .option("--icon <icon>", "Icon for the board")
  .option("--color <color>", "Color for the board")
  .action((slug: string, options: { name?: string; icon?: string; color?: string }) => {
    try {
      if (!isEnabled(FF_BOARD_METADATA)) {
        throw new Error("Board metadata feature is not enabled.");
      }
      const metadata = { name: options.name, icon: options.icon, color: options.color };
      const board = updateBoardMetadata(slug, metadata);
      console.log(`Updated board "${board.slug}".`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("set-default-workdir <slug> [workdir]")
  .description("Set or clear a board's default task workspace directory")
  .action((slug: string, workdir: string | undefined) => {
    try {
      if (!isEnabled(FF_DEFAULT_WORKDIR)) {
        throw new Error("Default workdir feature is not enabled.");
      }
      const board = setDefaultWorkdir(slug, workdir ?? null);
      if (board.default_workdir) {
        console.log(`Default workdir for board "${board.slug}" set to ${board.default_workdir}`);
      } else {
        console.log(`Default workdir for board "${board.slug}" cleared`);
      }
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

boardsCommand
  .command("rename <old-slug> <new-slug>")
  .description("Rename a board (updates slug, data directory, and current-board file)")
  .action((oldSlug: string, newSlug: string) => {
    try {
      if (!isEnabled(FF_BOARD_RENAME)) {
        throw new Error("Board rename feature is not enabled.");
      }
      assertValidBoardSlug(oldSlug, "old board slug");
      assertValidBoardSlug(newSlug, "new board slug");

      const { board } = renameBoard(oldSlug, newSlug);

      // Update current-board file if it referenced the old slug
      const current = readCurrentBoard();
      if (current === oldSlug) {
        writeCurrentBoard(newSlug);
      }

      console.log(`Renamed board "${oldSlug}" to "${board.slug}".`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

boardsCommand
  .command("rm <slug>")
  .description("Remove (archive) a board; use --delete for permanent deletion")
  .option("--delete", "Permanently delete the board and its data")
  .action((slug: string, options: { delete?: boolean }) => {
    try {
      const hardDelete = options.delete ?? false;
      if (hardDelete && !isEnabled(FF_BOARD_RM_DELETE)) {
        console.error("Error: Board hard-delete is not enabled. Set FF_BOARD_RM_DELETE=true to use --delete.");
        process.exit(1);
      }
      removeBoard(slug, hardDelete);
      if (hardDelete) {
        console.log(`Deleted board "${slug}" permanently.`);
      } else {
        console.log(`Archived board "${slug}".`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
