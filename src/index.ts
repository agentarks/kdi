#!/usr/bin/env bun
import { Command } from "commander";
import { initDb } from "./db";
import { boardsCommand } from "./commands/boards";
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

program.parse();
