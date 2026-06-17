import { Command } from "commander";
import { showBoard } from "../models/board";
import {
  defineWorkflowTemplate,
  listWorkflowTemplates,
} from "../models/workflowTemplate";
import { resolveBoard } from "../resolveBoard";
import { isEnabled, FF_WORKFLOW_TEMPLATES } from "../flags";

function requireFlag(): void {
  if (!isEnabled(FF_WORKFLOW_TEMPLATES)) {
    console.error("Workflow templates feature is not enabled.");
    process.exit(1);
  }
}

function parseSteps(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--steps must be a JSON array of strings.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--steps must be a JSON array.");
  }
  return parsed.map((s) => String(s));
}

function getBoardId(slug: string): number {
  const board = showBoard(slug, false);
  if (!board) {
    throw new Error(`Board "${slug}" not found or is archived.`);
  }
  return board.id;
}

export const defineWorkflowCommand = new Command("define")
  .description("Create or replace a workflow template")
  .argument("<template_id>", "Template identifier")
  .requiredOption("--name <name>", "Human-readable template name")
  .requiredOption("--steps <json>", "JSON array of step keys")
  .option("--board <slug>", "Board slug (resolved via chain)")
  .action((templateId: string, options: { name: string; steps: string; board?: string }) => {
    try {
      requireFlag();

      const boardSlug = resolveBoard(options.board);
      const boardId = getBoardId(boardSlug);
      const steps = parseSteps(options.steps);

      const template = defineWorkflowTemplate(
        boardId,
        templateId,
        options.name,
        steps
      );
      console.log(`Defined workflow template ${template.template_id} with ${template.steps.length} step(s).`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const listWorkflowsCommand = new Command("list")
  .description("List workflow templates for the resolved board")
  .option("--board <slug>", "Board slug (resolved via chain)")
  .option("--json", "Output as JSON")
  .action((options: { board?: string; json?: boolean }) => {
    try {
      requireFlag();

      const boardSlug = resolveBoard(options.board);
      const boardId = getBoardId(boardSlug);
      const templates = listWorkflowTemplates(boardId);

      if (options.json) {
        console.log(JSON.stringify({ board: boardSlug, templates }, null, 2));
        return;
      }

      if (templates.length === 0) {
        console.log("No workflow templates.");
        return;
      }

      console.log(`Workflow templates for ${boardSlug}:`);
      for (const template of templates) {
        console.log(`  ${template.template_id}: ${template.name}`);
        console.log(`    steps: ${template.steps.join(" → ")}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const workflowsCommand = new Command("workflows")
  .description("Manage workflow templates")
  .addCommand(defineWorkflowCommand)
  .addCommand(listWorkflowsCommand);
