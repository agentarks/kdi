export const FF_ENABLE_KANBAN_DISPATCH = "FF_ENABLE_KANBAN_DISPATCH";
export const FF_WORKER_LOG_CAPTURE = "FF_WORKER_LOG_CAPTURE";
export const FF_SCHEDULED_STATUS = "FF_SCHEDULED_STATUS";
export const FF_REVIEW_STATUS = "FF_REVIEW_STATUS";
export const FF_COMPLETE_METADATA = "FF_COMPLETE_METADATA";
export const FF_PRIORITY_INTEGER = "FF_PRIORITY_INTEGER";
export const FF_MAX_RUNTIME = "FF_MAX_RUNTIME";
export const FF_SKILLS_ARRAY = "FF_SKILLS_ARRAY";
export const FF_TENANT_NAMESPACE = "FF_TENANT_NAMESPACE";
export const FF_CREATED_BY = "FF_CREATED_BY";
export const FF_MODEL_OVERRIDE = "FF_MODEL_OVERRIDE";
export const FF_MAX_RETRIES = "FF_MAX_RETRIES";
export const FF_BOARD_METADATA = "FF_BOARD_METADATA";
export const FF_BOARD_RM_DELETE = "FF_BOARD_RM_DELETE";
export const FF_BOARD_RENAME = "FF_BOARD_RENAME";
export const FF_BOARD_SWITCH = "FF_BOARD_SWITCH";
export const FF_BOARD_CREATE_SWITCH = "FF_BOARD_CREATE_SWITCH";
export const FF_GLOBAL_BOARD = "FF_GLOBAL_BOARD";
export const FF_DEFAULT_WORKDIR = "FF_DEFAULT_WORKDIR";
export const FF_ASSIGN_REASSIGN = "FF_ASSIGN_REASSIGN";
export const FF_CRASH_GRACE_PERIOD = "FF_CRASH_GRACE_PERIOD";
export const FF_HEARTBEAT = "FF_HEARTBEAT";
export const FF_RATE_LIMIT_EXIT_CODE = "FF_RATE_LIMIT_EXIT_CODE";
export const FF_STATS = "FF_STATS";
export const FF_GC = "FF_GC";
export const FF_ASSIGNEES_LISTING = "FF_ASSIGNEES_LISTING";
export const FF_TASK_ATTACHMENTS = "FF_TASK_ATTACHMENTS";
export const FF_DIAGNOSTICS = "FF_DIAGNOSTICS";
export const FF_CONTEXT_BUILDER = "FF_CONTEXT_BUILDER";
export const FF_NOTIFY_SUBS = "FF_NOTIFY_SUBS";
export const FF_LIST_FILTERS_SORT = "FF_LIST_FILTERS_SORT";
export const FF_SHOW_RUN_FILTERING = "FF_SHOW_RUN_FILTERING";
export const FF_RUNS_FILTERING = "FF_RUNS_FILTERING";
export const FF_BULK_OPERATIONS = "FF_BULK_OPERATIONS";
export const FF_COMMENT_ENHANCEMENTS = "FF_COMMENT_ENHANCEMENTS";
export const FF_DISPATCH_CONTROLS = "FF_DISPATCH_CONTROLS";
export const FF_WATCH_FILTERS = "FF_WATCH_FILTERS";
export const FF_WORKFLOW_TEMPLATES = "FF_WORKFLOW_TEMPLATES";
export const FF_TRIAGE_AUTOMATION = "FF_TRIAGE_AUTOMATION";
export const FF_SWARM_MODE = "FF_SWARM_MODE";
export const FF_DISPATCHER_PRESENCE_WARNING = "FF_DISPATCHER_PRESENCE_WARNING";
export const FF_GOAL_MODE = "FF_GOAL_MODE";
export const FF_DISPATCH_ONCE = "FF_DISPATCH_ONCE";
export const FF_LINK_UNLINK = "FF_LINK_UNLINK";
export const FF_CREATE_PARENT = "FF_CREATE_PARENT";

const flagRegistry = new Map<string, boolean>();
const flagOverrides = new Map<string, boolean>();

export function registerFlag(flag: string, defaultValue: boolean): void {
  flagRegistry.set(flag, defaultValue);
}

export function setFlag(flag: string, value: boolean): void {
  flagOverrides.set(flag, value);
}

export function isEnabled(flag: string): boolean {
  // Security: only check env vars for registered flags
  if (flagRegistry.has(flag)) {
    const envValue = Bun.env[flag];
    if (envValue !== undefined) {
      const trimmed = envValue.trim();
      return trimmed === "1" || trimmed.toLowerCase() === "true";
    }
  }

  // Check programmatic override
  if (flagOverrides.has(flag)) {
    return flagOverrides.get(flag)!;
  }

  // Check registry default
  if (flagRegistry.has(flag)) {
    return flagRegistry.get(flag)!;
  }

  // Unknown flags default to false
  return false;
}

export function clearOverrides(): void {
  flagOverrides.clear();
}

// Register built-in flags
registerFlag(FF_ENABLE_KANBAN_DISPATCH, false);
registerFlag(FF_WORKER_LOG_CAPTURE, false);
registerFlag(FF_SCHEDULED_STATUS, false);
registerFlag(FF_REVIEW_STATUS, false);
registerFlag(FF_COMPLETE_METADATA, false);
registerFlag(FF_PRIORITY_INTEGER, false);
registerFlag(FF_MAX_RUNTIME, false);
registerFlag(FF_SKILLS_ARRAY, false);
registerFlag(FF_TENANT_NAMESPACE, false);
registerFlag(FF_CREATED_BY, false);
registerFlag(FF_MODEL_OVERRIDE, false);
registerFlag(FF_MAX_RETRIES, false);
registerFlag(FF_BOARD_METADATA, false);
registerFlag(FF_BOARD_RM_DELETE, false);
registerFlag(FF_BOARD_RENAME, false);
registerFlag(FF_BOARD_SWITCH, false);
registerFlag(FF_BOARD_CREATE_SWITCH, false);
registerFlag(FF_GLOBAL_BOARD, false);
registerFlag(FF_DEFAULT_WORKDIR, false);
registerFlag(FF_ASSIGN_REASSIGN, false);
registerFlag(FF_CRASH_GRACE_PERIOD, false);
registerFlag(FF_HEARTBEAT, false);
registerFlag(FF_RATE_LIMIT_EXIT_CODE, false);
registerFlag(FF_STATS, false);
registerFlag(FF_GC, false);
registerFlag(FF_ASSIGNEES_LISTING, false);
registerFlag(FF_TASK_ATTACHMENTS, false);
registerFlag(FF_DIAGNOSTICS, false);
registerFlag(FF_CONTEXT_BUILDER, false);
registerFlag(FF_NOTIFY_SUBS, false);
registerFlag(FF_LIST_FILTERS_SORT, false);
registerFlag(FF_SHOW_RUN_FILTERING, false);
registerFlag(FF_RUNS_FILTERING, false);
registerFlag(FF_BULK_OPERATIONS, false);
registerFlag(FF_COMMENT_ENHANCEMENTS, false);
registerFlag(FF_DISPATCH_CONTROLS, false);
registerFlag(FF_WATCH_FILTERS, false);
registerFlag(FF_WORKFLOW_TEMPLATES, false);
registerFlag(FF_TRIAGE_AUTOMATION, false);
registerFlag(FF_SWARM_MODE, false);
registerFlag(FF_DISPATCHER_PRESENCE_WARNING, false);
registerFlag(FF_GOAL_MODE, false);
registerFlag(FF_DISPATCH_ONCE, false);
registerFlag(FF_LINK_UNLINK, false);
registerFlag(FF_CREATE_PARENT, false);
