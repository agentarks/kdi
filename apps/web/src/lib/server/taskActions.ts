import { initDb } from "~/db";
import {
  archiveTask,
  assignTask,
  blockTask,
  completeTask,
  listTasks,
  promoteTaskAdvanced,
  reassignTask,
  reviewTask,
  scheduleTask,
  showTask,
  unblockTask,
  unassignTask,
  type PromoteTaskResult,
} from "~/models/task";
import { atomicClaim, heartbeat, reclaimTask } from "~/models/claim";
import { getBoardById, showBoard } from "~/models/board";
import { readCurrentBoard } from "~/resolveBoard";
import {
  FF_ASSIGN_REASSIGN,
  FF_BULK_OPERATIONS,
  FF_COMPLETE_METADATA,
  FF_HEARTBEAT,
  FF_REVIEW_STATUS,
  FF_SCHEDULED_STATUS,
  isEnabled,
} from "~/flags";

export type ActionStatus = "success" | "skipped" | "error";

export interface TaskActionResult {
  taskId: number;
  status: ActionStatus;
  message: string;
  currentStatus?: string;
}

export interface BulkResult {
  results: TaskActionResult[];
  summary: {
    attempted: number;
    succeeded: number;
    skipped: number;
    failed: number;
  };
}

function resolveCurrentProfile(): string {
  return (
    process.env.KDI_PROFILE || process.env.HERMES_PROFILE || "user"
  );
}

function parseTaskId(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const parsed = Number(String(value));
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && String(numeric) === trimmed) {
    return Math.floor(numeric);
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function formatPromote(
  id: number,
  result: PromoteTaskResult,
  dryRun: boolean
): TaskActionResult {
  switch (result.status) {
    case "promoted":
      return {
        taskId: id,
        status: "success",
        message: `Promoted task ${id} to ready.`,
        currentStatus: result.task.status,
      };
    case "would_promote":
      return {
        taskId: id,
        status: "success",
        message: dryRun
          ? `Dry run: task ${id} would promote.`
          : `Task ${id} would promote.`,
        currentStatus: "todo",
      };
    case "not_found":
      return { taskId: id, status: "skipped", message: "skipped: not_found" };
    case "archived":
      return { taskId: id, status: "skipped", message: "skipped: archived" };
    case "wrong_status":
      return {
        taskId: id,
        status: "skipped",
        message: `skipped: wrong_status (current: ${result.current})`,
      };
    case "blocked_by_dependencies":
      return {
        taskId: id,
        status: "skipped",
        message: "skipped: blocked_by_dependencies",
      };
  }
}

export function loadTaskList(boardSlug: string) {
  initDb();
  const board = showBoard(boardSlug);
  if (!board) {
    return { board: null, tasks: [] };
  }
  const tasks = listTasks({ board_id: board.id, includeArchived: false });
  return { board, tasks };
}

export function loadTaskDetail(taskId: number) {
  initDb();
  const task = showTask(taskId);
  const board = task ? getBoardById(task.board_id) : null;
  return { task, board };
}

export function applyTaskAction(
  action: string,
  taskId: number,
  formData: FormData
): TaskActionResult {
  initDb();
  switch (action) {
    case "promote": {
      const force = formData.has("force");
      const dryRun = formData.has("dryRun");
      if ((force || dryRun) && !isEnabled(FF_BULK_OPERATIONS)) {
        return {
          taskId,
          status: "error",
          message: "Bulk operations feature is not enabled.",
        };
      }
      const result = promoteTaskAdvanced(taskId, { force, dryRun });
      return formatPromote(taskId, result, dryRun);
    }

    case "block": {
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return {
          taskId,
          status: "error",
          message: "Block reason is required.",
        };
      }
      const task = blockTask(taskId, reason);
      return {
        taskId,
        status: "success",
        message: `Blocked task ${taskId}.`,
        currentStatus: task.status,
      };
    }

    case "unblock": {
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const current = showTask(taskId);
      if (current?.status === "scheduled" && !isEnabled(FF_SCHEDULED_STATUS)) {
        return {
          taskId,
          status: "error",
          message: "Scheduled status feature is not enabled.",
        };
      }
      const task = unblockTask(taskId, reason);
      return {
        taskId,
        status: "success",
        message:
          task.status === "ready"
            ? `Task ${taskId} is now ready.`
            : `Unblocked task ${taskId}.`,
        currentStatus: task.status,
      };
    }

    case "schedule": {
      if (!isEnabled(FF_SCHEDULED_STATUS)) {
        return {
          taskId,
          status: "error",
          message: "Scheduled status feature is not enabled.",
        };
      }
      const at = parseTimestamp(String(formData.get("at") ?? ""));
      if (at === null) {
        return {
          taskId,
          status: "error",
          message: "Invalid scheduled time.",
        };
      }
      const now = Math.floor(Date.now() / 1000);
      if (at <= now) {
        return {
          taskId,
          status: "error",
          message: "Scheduled time must be in the future",
        };
      }
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const task = scheduleTask(taskId, at, reason);
      return {
        taskId,
        status: "success",
        message: `Scheduled task ${taskId} for ${new Date(
          at * 1000
        ).toISOString()}.`,
        currentStatus: task.status,
      };
    }

    case "review": {
      if (!isEnabled(FF_REVIEW_STATUS)) {
        return {
          taskId,
          status: "error",
          message: "Review status feature is not enabled.",
        };
      }
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const task = reviewTask(taskId, reason);
      return {
        taskId,
        status: "success",
        message: `Marked task ${taskId} as under review.`,
        currentStatus: task.status,
      };
    }

    case "archive": {
      const task = archiveTask(taskId);
      return {
        taskId,
        status: "success",
        message: `Archived task ${taskId}.`,
        currentStatus: task.status,
      };
    }

    case "complete": {
      const result = String(formData.get("result") ?? "").trim() || undefined;
      const summary =
        String(formData.get("summary") ?? "").trim() || undefined;
      const metadata =
        String(formData.get("metadata") ?? "").trim() || undefined;
      if (metadata !== undefined && !isEnabled(FF_COMPLETE_METADATA)) {
        return {
          taskId,
          status: "error",
          message: "Complete --metadata is not enabled.",
        };
      }
      if (metadata !== undefined) {
        try {
          JSON.parse(metadata);
        } catch {
          return {
            taskId,
            status: "error",
            message: "Metadata must be valid JSON.",
          };
        }
      }
      const task = completeTask(taskId, { result, summary, metadata });
      return {
        taskId,
        status: "success",
        message: `Completed task ${taskId}.`,
        currentStatus: task.status,
      };
    }

    case "assign": {
      if (!isEnabled(FF_ASSIGN_REASSIGN)) {
        return {
          taskId,
          status: "error",
          message: "Assign/reassign feature is not enabled.",
        };
      }
      const profile = String(formData.get("profile") ?? "").trim();
      if (profile === "") {
        return {
          taskId,
          status: "error",
          message: "Profile cannot be empty.",
        };
      }
      if (profile.toLowerCase() === "none") {
        const task = unassignTask(taskId);
        return {
          taskId,
          status: "success",
          message: `Unassigned task ${taskId}.`,
          currentStatus: task.status,
        };
      }
      const task = assignTask(taskId, profile);
      return {
        taskId,
        status: "success",
        message: `Assigned task ${taskId} to ${profile}.`,
        currentStatus: task.status,
      };
    }

    case "reassign": {
      if (!isEnabled(FF_ASSIGN_REASSIGN)) {
        return {
          taskId,
          status: "error",
          message: "Assign/reassign feature is not enabled.",
        };
      }
      const profile = String(formData.get("profile") ?? "").trim();
      if (profile === "") {
        return {
          taskId,
          status: "error",
          message: "Profile cannot be empty.",
        };
      }
      const reclaim = formData.has("reclaim");
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      const targetProfile =
        profile.toLowerCase() === "none" ? null : profile;
      const task = reassignTask(taskId, targetProfile, { reclaim, reason });
      return {
        taskId,
        status: "success",
        message:
          targetProfile === null
            ? `Unassigned task ${taskId}.`
            : `Reassigned task ${taskId} to ${profile}.`,
        currentStatus: task.status,
      };
    }

    case "claim": {
      const profile =
        String(formData.get("profile") ?? "").trim() ||
        resolveCurrentProfile();
      const ttl = parseTaskId(formData.get("ttl")) ?? undefined;
      const result = atomicClaim(taskId, profile, ttl);
      if (!result.success) {
        return {
          taskId,
          status: "error",
          message: `Task ${taskId} is not available for claim (not ready or already claimed).`,
        };
      }
      return {
        taskId,
        status: "success",
        message: `Claimed task ${taskId}.`,
      };
    }

    case "reclaim": {
      const reason = String(formData.get("reason") ?? "").trim() || undefined;
      if (reason !== undefined && !isEnabled(FF_ASSIGN_REASSIGN)) {
        return {
          taskId,
          status: "error",
          message: "The --reason option requires the assign/reassign feature.",
        };
      }
      const ok = reclaimTask(taskId, reason);
      if (!ok) {
        return {
          taskId,
          status: "error",
          message: `Task ${taskId} is not running or has no active claim.`,
        };
      }
      return {
        taskId,
        status: "success",
        message: `Reclaimed task ${taskId}.`,
      };
    }

    case "heartbeat": {
      if (!isEnabled(FF_HEARTBEAT)) {
        return {
          taskId,
          status: "error",
          message: "Heartbeat feature is not enabled.",
        };
      }
      const current = showTask(taskId);
      if (!current) {
        return { taskId, status: "error", message: `Task ${taskId} not found.` };
      }
      if (current.status === "archived") {
        return {
          taskId,
          status: "error",
          message: `Task ${taskId} is archived.`,
        };
      }
      if (current.status !== "running") {
        return {
          taskId,
          status: "error",
          message: `Task ${taskId} is not running.`,
        };
      }
      let note = String(formData.get("note") ?? "").trim() || undefined;
      if (note !== undefined && note.length > 4096) {
        note = note.slice(0, 4096);
      }
      const ok = heartbeat(taskId, note);
      if (!ok) {
        return {
          taskId,
          status: "error",
          message: `Task ${taskId} is not running.`,
        };
      }
      return {
        taskId,
        status: "success",
        message: `Heartbeat recorded for task ${taskId}.`,
      };
    }

    default:
      return {
        taskId,
        status: "error",
        message: `Unknown action: ${action}`,
      };
  }
}

export function applyBulkAction(
  action: string,
  ids: number[],
  formData: FormData
): BulkResult {
  initDb();
  if (!isEnabled(FF_BULK_OPERATIONS)) {
    return {
      results: ids.map((id) => ({
        taskId: id,
        status: "error" as const,
        message: "Bulk operations feature is not enabled.",
      })),
      summary: { attempted: ids.length, succeeded: 0, skipped: 0, failed: ids.length },
    };
  }

  const results: TaskActionResult[] = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const id of ids) {
    let result: TaskActionResult;
    try {
      const current = showTask(id);
      if (!current) {
        result = { taskId: id, status: "skipped", message: "skipped: not_found" };
      } else if (action === "block") {
        if (current.status === "blocked") {
          result = { taskId: id, status: "skipped", message: "skipped: already blocked" };
        } else if (current.archived_at !== null) {
          result = { taskId: id, status: "skipped", message: "skipped: already archived" };
        } else {
          result = applyTaskAction(action, id, formData);
        }
      } else if (action === "unblock") {
        if (current.status === "scheduled" && !isEnabled(FF_SCHEDULED_STATUS)) {
          result = { taskId: id, status: "error", message: "Scheduled status feature is not enabled." };
        } else if (current.status !== "blocked" && current.status !== "scheduled") {
          result = { taskId: id, status: "skipped", message: `skipped: wrong_status (current: ${current.status})` };
        } else {
          result = applyTaskAction(action, id, formData);
        }
      } else {
        result = applyTaskAction(action, id, formData);
      }
    } catch (err: any) {
      result = { taskId: id, status: "error", message: err.message };
    }

    results.push(result);
    if (result.status === "success") succeeded++;
    else if (result.status === "skipped") skipped++;
    else failed++;
  }

  return {
    results,
    summary: {
      attempted: ids.length,
      succeeded,
      skipped,
      failed,
    },
  };
}

export function resolveBoardSlug(
  queryBoard: string | null,
  envBoard: string | undefined
): string {
  return queryBoard || envBoard || readCurrentBoard() || "default";
}
