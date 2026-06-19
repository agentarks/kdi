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
const program = new Command();

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch for Coding Agents")
  .version("0.1.0");

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

program.parse();
