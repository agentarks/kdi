// Shared lifecycle-action client logic used by both TaskActions (detail panel)
// and TaskCard (row menu). Keeps gating + POST in one place so neither drifts.

import type { LifecycleAction, LifecycleFlags, LifecycleFields, LifecycleResult } from "$lib/types";

// Minimal task shape the gating predicates need. Works for both KanbanTask and
// TaskDetailTask (both have these fields).
export interface TaskLike {
  id: number;
  status: string;
  archivedAt: number | null;
  claimLock?: string | null;
}

export const ROW_ACTIONS: { action: LifecycleAction; label: string; needsField?: "reason" | "datetime" | "profile" }[] = [
  { action: "promote", label: "Promote" },
  { action: "block", label: "Block", needsField: "reason" },
  { action: "unblock", label: "Unblock" },
  { action: "schedule", label: "Schedule", needsField: "datetime" },
  { action: "review", label: "Review", needsField: "reason" },
  { action: "claim", label: "Claim" },
  { action: "reclaim", label: "Reclaim" },
  { action: "assign", label: "Assign", needsField: "profile" },
  { action: "reassign", label: "Reassign", needsField: "profile" },
  { action: "heartbeat", label: "Heartbeat" },
  { action: "complete", label: "Complete" },
  { action: "archive", label: "Archive" },
];

export function canPerform(action: LifecycleAction, task: TaskLike, flags: LifecycleFlags): boolean {
  const archived = task.archivedAt !== null;
  switch (action) {
    case "promote": return task.status === "todo" && !archived;
    case "block": return task.status !== "blocked" && !archived;
    case "unblock": return (task.status === "blocked" || task.status === "scheduled") && !archived;
    case "schedule": return flags.scheduledStatus && !archived;
    case "review": return flags.reviewStatus && task.status !== "review" && !archived;
    case "archive": return !archived;
    case "complete": return !archived;
    case "assign": return flags.assignReassign && !archived;
    case "reassign": return flags.assignReassign && !archived;
    case "claim": return task.status === "ready" && !archived;
    case "reclaim": return task.status === "running" && (task.claimLock !== undefined ? task.claimLock !== null : true) && !archived;
    case "heartbeat": return flags.heartbeat && task.status === "running" && !archived;
  }
}

export function actionTooltip(action: LifecycleAction, task: TaskLike, flags: LifecycleFlags): string | undefined {
  if (canPerform(action, task, flags)) return undefined;
  const archived = task.archivedAt !== null;
  if (archived) return "Task is archived";
  switch (action) {
    case "promote": return task.status === "todo" ? undefined : `Only todo tasks (current: ${task.status})`;
    case "block": return task.status === "blocked" ? "Already blocked" : undefined;
    case "unblock": return "Only blocked or scheduled tasks";
    case "schedule": return !flags.scheduledStatus ? "FF_SCHEDULED_STATUS" : undefined;
    case "review": return !flags.reviewStatus ? "FF_REVIEW_STATUS" : (task.status === "review" ? "Already in review" : undefined);
    case "assign":
    case "reassign": return !flags.assignReassign ? "FF_ASSIGN_REASSIGN" : undefined;
    case "claim": return task.status !== "ready" ? `Only ready tasks (current: ${task.status})` : undefined;
    case "reclaim": return task.status !== "running" ? `Only running tasks (current: ${task.status})` : "No active claim";
    case "heartbeat": return !flags.heartbeat ? "FF_HEARTBEAT" : (task.status !== "running" ? "Only running tasks" : undefined);
    default: return undefined;
  }
}

export async function postTaskAction(
  boardSlug: string,
  taskId: number,
  action: LifecycleAction,
  fields: LifecycleFields = {},
): Promise<{ ok: boolean; result: LifecycleResult }> {
  const res = await fetch(`/api/boards/${boardSlug}/tasks/${taskId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, result: data.result as LifecycleResult };
  return { ok: false, result: { taskId, status: "error" as const, message: data.message ?? `Request failed (${res.status})` } };
}
