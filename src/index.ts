#!/usr/bin/env bun
import { Command } from "commander";
import { initDb } from "./db";
import { boardsCommand } from "./commands/boards";
import {
  createTaskCommand,
  listTasksCommand,
  showTaskCommand,
  editTaskCommand,
  commentTaskCommand,
  attachTaskCommand,
  promoteTaskCommand,
  blockTaskCommand,
  unblockTaskCommand,
  reviewTaskCommand,
  stepTaskCommand,
  archiveTaskCommand,
  specifyTaskCommand,
  decomposeTaskCommand,
  listRunsCommand,
  tailTaskCommand,
  watchCommand,
  claimTaskCommand,
  reclaimTaskCommand,
  heartbeatTaskCommand,
  logTaskCommand,
  completeTaskCommand,
  scheduleTaskCommand,
  assignTaskCommand,
  reassignTaskCommand,
} from "./commands/tasks";
import { dispatchCommand } from "./commands/dispatch";
import { initCommand } from "./commands/init";
import { statsCommand } from "./commands/stats";
import { gcCommand } from "./commands/gc";
import { assigneesCommand } from "./commands/assignees";
import { diagnosticsCommand } from "./commands/diagnostics";
import { contextCommand } from "./commands/context";
import { ensureProfiles } from "./profiles";
import { ensureNotifiers } from "./notifiers";
import {
  notifySubscribeCommand,
  notifyListCommand,
  notifyUnsubscribeCommand,
} from "./commands/notify";
import { workflowsCommand } from "./commands/workflows";
import { swarmCommand } from "./commands/swarm";
import { linkCommand, unlinkCommand } from "./commands/links";
import { isEnabled, FF_GLOBAL_BOARD } from "./flags";

const program = new Command();

// ponytail: scan argv up to the first non-option token (the subcommand
// name) for a program-level `--board <slug>`. Set KDI_BOARD and remove
// those tokens. Commander's option resolution claims parent options even
// when they appear after a subcommand name, which would shadow subcommands
// that also accept --board. Manual extraction keeps program-level and
// subcommand-level --board separated and lets Commander see a clean argv.
function extractAndStripProgramBoard(argv: string[]): { board: string | null; stripped: string[] } {
  // Skip argv[0] (bun path) and argv[1] (script path). Anything before the
  // first user-arg non-option token is a "program option".
  const start = 2;
  const out: string[] = argv.slice(0, start);
  let board: string | null = null;
  let hitSubcommand = false;
  for (let i = start; i < argv.length; i++) {
    const tok = argv[i];
    if (!hitSubcommand && (tok === "--board" || tok.startsWith("--board="))) {
      if (tok === "--board") {
        if (i + 1 >= argv.length) {
          out.push(tok);
          continue;
        }
        board = argv[i + 1];
        i++;
      } else {
        board = tok.slice("--board=".length);
      }
      continue;
    }
    if (!hitSubcommand && !tok.startsWith("-") && tok !== "") {
      hitSubcommand = true;
    }
    out.push(tok);
  }
  return { board, stripped: out };
}

const { board: programBoard, stripped: strippedArgv } = extractAndStripProgramBoard(process.argv);
if (programBoard !== null) {
  if (!isEnabled(FF_GLOBAL_BOARD)) {
    console.error("Error: Global --board flag is not enabled.");
    process.exit(1);
  }
  process.env.KDI_BOARD = programBoard;
  // Mutate process.argv so Commander parses the cleaned argv.
  process.argv = strippedArgv;
}

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch for Coding Agents")
  .version("0.1.0")
  // Note: the program-level --board option is intentionally NOT registered
  // with Commander. Doing so would cause Commander to claim any `--board`
  // token in argv (even those intended for subcommands), shadowing subcommands
  // that also accept --board. We handle the program-level --board entirely
  // via the pre-parse above. The option is documented in --help via a
  // hand-written line below.
  .addHelpText("beforeAll", "  --board <slug>          Board slug (sets KDI_BOARD; lower priority than the subcommand's own --board). Feature-flagged: FF_GLOBAL_BOARD.\n");

try {
  initDb();
} catch (err: any) {
  console.warn(`Warning: Could not initialize database: ${err.message}`);
  console.warn(`Run "kdi init" to initialize the database.`);
}

try {
  ensureProfiles();
} catch (err: any) {
  console.warn(`Warning: Could not initialize profiles: ${err.message}`);
}

try {
  ensureNotifiers();
} catch (err: any) {
  console.warn(`Warning: Could not initialize notifiers: ${err.message}`);
}

program.addCommand(boardsCommand);
program.addCommand(createTaskCommand);
program.addCommand(listTasksCommand);
program.addCommand(showTaskCommand);
program.addCommand(editTaskCommand);
program.addCommand(commentTaskCommand);
program.addCommand(attachTaskCommand);
program.addCommand(promoteTaskCommand);
program.addCommand(blockTaskCommand);
program.addCommand(unblockTaskCommand);
program.addCommand(reviewTaskCommand);
program.addCommand(archiveTaskCommand);
program.addCommand(specifyTaskCommand);
program.addCommand(decomposeTaskCommand);
program.addCommand(listRunsCommand);
program.addCommand(tailTaskCommand);
program.addCommand(watchCommand);
program.addCommand(assignTaskCommand);
program.addCommand(reassignTaskCommand);
program.addCommand(claimTaskCommand);
program.addCommand(reclaimTaskCommand);
program.addCommand(heartbeatTaskCommand);
program.addCommand(logTaskCommand);
program.addCommand(completeTaskCommand);
program.addCommand(scheduleTaskCommand);
program.addCommand(stepTaskCommand);
program.addCommand(workflowsCommand);
program.addCommand(assigneesCommand);
program.addCommand(initCommand);
program.addCommand(dispatchCommand);
program.addCommand(statsCommand);
program.addCommand(gcCommand);
program.addCommand(diagnosticsCommand);
program.addCommand(contextCommand);
program.addCommand(notifySubscribeCommand);
program.addCommand(notifyListCommand);
program.addCommand(notifyUnsubscribeCommand);
program.addCommand(swarmCommand);
program.addCommand(linkCommand);
program.addCommand(unlinkCommand);

program.parse();
