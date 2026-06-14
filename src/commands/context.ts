import { Command } from "commander";
import { isEnabled, FF_CONTEXT_BUILDER } from "../flags";
import { resolveBoard } from "../resolveBoard";
import { buildTaskContext, type TaskContext } from "../models/context";

export function createContextCommand(): Command {
  return new Command("context")
    .description("Build worker context for a task")
    .argument("<task_id>", "Task ID")
    .option("--board <slug>", "Board slug (resolved via chain)")
    .option("--json", "Output as JSON")
    .action(contextAction);
}

function contextAction(taskIdArg: string, options: { board?: string; json?: boolean }) {
    try {
      if (!isEnabled(FF_CONTEXT_BUILDER)) {
        console.error("Context builder is not enabled.");
        process.exit(1);
      }

      const taskId = parseInt(taskIdArg, 10);
      if (isNaN(taskId) || taskId <= 0) {
        console.error(`Invalid task ID: ${taskIdArg}`);
        process.exit(1);
      }

      const boardSlug = resolveBoard(options.board);
      const ctx = buildTaskContext(taskId, boardSlug);

      if (options.json) {
        console.log(JSON.stringify(ctx, null, 2));
        return;
      }

      console.log(formatContext(ctx));
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
}

export const contextCommand = createContextCommand();

function formatTimestamp(ts: number | null): string {
  if (ts === null) return "(none)";
  try {
    return new Date(ts * 1000).toISOString();
  } catch {
    return String(ts);
  }
}

function formatContext(ctx: TaskContext): string {
  const lines: string[] = [];

  lines.push(`# Task #${ctx.task_id}: ${ctx.title}`);
  lines.push(`Status: ${ctx.status}`);
  lines.push(`Priority: ${ctx.priority}`);
  if (ctx.assignee !== undefined) {
    lines.push(`Assignee: ${ctx.assignee}`);
  }
  if (ctx.tenant !== undefined) {
    lines.push(`Tenant: ${ctx.tenant}`);
  }
  if (ctx.created_by !== undefined) {
    lines.push(`Created by: ${ctx.created_by}`);
  }

  lines.push("");
  lines.push("## Body");
  lines.push(ctx.body || "(empty)");

  lines.push("");
  lines.push("## Parent Results");
  if (ctx.parents.length === 0) {
    lines.push("(none)");
  } else {
    for (const parent of ctx.parents) {
      lines.push(`### Parent #${parent.task_id}: ${parent.title}`);
      lines.push(`Result: ${parent.result || "(none)"}`);
      lines.push(`Summary: ${parent.summary || "(none)"}`);
    }
    if (ctx.older_parents_omitted > 0) {
      lines.push(`(${ctx.older_parents_omitted} older parents omitted)`);
    }
  }

  lines.push("");
  lines.push("## Prior Attempts");
  if (ctx.prior_attempts.length === 0) {
    lines.push("(none)");
  } else {
    for (const run of ctx.prior_attempts) {
      lines.push(`### Run #${run.run_id} (${run.profile ?? "unknown"}) — ${run.status}`);
      if (run.outcome !== null) {
        lines.push(`Outcome: ${run.outcome}`);
      }
      lines.push(`Summary: ${run.summary || "(none)"}`);
      lines.push(`Error: ${run.error || "(none)"}`);
      lines.push(`Started: ${formatTimestamp(run.started_at)}`);
      lines.push(`Ended: ${formatTimestamp(run.ended_at)}`);
    }
    if (ctx.older_attempts_omitted > 0) {
      lines.push(`(${ctx.older_attempts_omitted} older attempts omitted)`);
    }
  }

  lines.push("");
  lines.push("## Role History");
  if (ctx.role_history.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of ctx.role_history) {
      const note = entry.note ? `: ${entry.note}` : "";
      lines.push(`- ${formatTimestamp(entry.at)} ${entry.event} by ${entry.actor}${note}`);
    }
    if (ctx.older_role_history_omitted > 0) {
      lines.push(`(${ctx.older_role_history_omitted} older role history entries omitted)`);
    }
  }

  lines.push("");
  lines.push("## Comments");
  if (ctx.comments.length === 0) {
    lines.push("(none)");
  } else {
    for (const comment of ctx.comments) {
      lines.push(`[${formatTimestamp(comment.created_at)}] ${comment.author}: ${comment.text}`);
    }
    if (ctx.older_comments_omitted > 0) {
      lines.push(`(${ctx.older_comments_omitted} older comments omitted)`);
    }
  }

  lines.push("");
  lines.push("## Attachments");
  if (ctx.attachments.length === 0) {
    lines.push("(none)");
  } else {
    for (const attachment of ctx.attachments) {
      lines.push(`${attachment.filename}: ${attachment.absolute_path}`);
    }
  }

  return lines.join("\n");
}
