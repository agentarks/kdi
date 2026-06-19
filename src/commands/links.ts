import { Command } from "commander";
import { addDependency, removeDependency } from "../models/dependency";
import { showTask } from "../models/task";
import { isEnabled, FF_LINK_UNLINK } from "../flags";

function parseTaskId(raw: string): number {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid task ID: ${raw}`);
  }
  return id;
}

function requireFlag(): void {
  if (!isEnabled(FF_LINK_UNLINK)) {
    throw new Error("Link/unlink feature is not enabled.");
  }
}

export const linkCommand = new Command("link")
  .description("Link a parent task to a child task (parent must complete first)")
  .argument("<parent_id>", "Parent task ID")
  .argument("<child_id>", "Child task ID")
  .action((parentIdRaw: string, childIdRaw: string) => {
    try {
      requireFlag();
      const parentId = parseTaskId(parentIdRaw);
      const childId = parseTaskId(childIdRaw);
      if (!showTask(parentId)) throw new Error(`Task ${parentId} not found.`);
      if (!showTask(childId)) throw new Error(`Task ${childId} not found.`);
      addDependency(parentId, childId);
      console.log(`Linked ${parentId} -> ${childId}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const unlinkCommand = new Command("unlink")
  .description("Remove a parent->child dependency")
  .argument("<parent_id>", "Parent task ID")
  .argument("<child_id>", "Child task ID")
  .action((parentIdRaw: string, childIdRaw: string) => {
    try {
      requireFlag();
      const parentId = parseTaskId(parentIdRaw);
      const childId = parseTaskId(childIdRaw);
      const removed = removeDependency(parentId, childId);
      if (!removed) {
        console.error(`Error: No link from ${parentId} to ${childId}.`);
        process.exit(1);
      }
      console.log(`Unlinked ${parentId} -> ${childId}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
