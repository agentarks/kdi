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
  promoteTaskCommand,
  blockTaskCommand,
  unblockTaskCommand,
  archiveTaskCommand,
} from "./commands/tasks";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const program = new Command();

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch for Coding Agents")
  .version("0.1.0");

const dbDir = `${homedir()}/.local/share/kdi`;
const dbPath = `${dbDir}/kdi.db`;

mkdirSync(dbDir, { recursive: true });

try {
  initDb(dbPath);
} catch (err: any) {
  console.error(`Failed to initialize database: ${err.message}`);
  process.exit(1);
}

program.addCommand(boardsCommand);
program.addCommand(createTaskCommand);
program.addCommand(listTasksCommand);
program.addCommand(showTaskCommand);
program.addCommand(editTaskCommand);
program.addCommand(commentTaskCommand);
program.addCommand(promoteTaskCommand);
program.addCommand(blockTaskCommand);
program.addCommand(unblockTaskCommand);
program.addCommand(archiveTaskCommand);

program.parse();
