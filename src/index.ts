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

try {
  mkdirSync(dbDir, { recursive: true });
} catch {
  // ignore
}

initDb(dbPath);

program.addCommand(boardsCommand);

program.parse();
