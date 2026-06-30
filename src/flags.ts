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
export const FF_BOARD_RENAME_HERMES = "FF_BOARD_RENAME_HERMES";
export const FF_BOARD_SWITCH = "FF_BOARD_SWITCH";
export const FF_BOARD_CREATE_SWITCH = "FF_BOARD_CREATE_SWITCH";
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
export const FF_GLOBAL_BOARD = "FF_GLOBAL_BOARD";
export const FF_CREATE_PARENT = "FF_CREATE_PARENT";
export const FF_TAIL_NO_FOLLOW = "FF_TAIL_NO_FOLLOW";
export const FF_HARNESS_CONTEXT = "FF_HARNESS_CONTEXT";
export const FF_RESULT_SUMMARY = "FF_RESULT_SUMMARY";
export const FF_WORKTREE_HANDOFF = "FF_WORKTREE_HANDOFF";
export const FF_REAL_HARNESS_PROFILES = "FF_REAL_HARNESS_PROFILES";

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
//
// Rollout policy (post KDI-054 Hermes parity smoke test):
// - Core task lifecycle, board management, dispatch, and observability flags
//   are promoted to Active (default true). Users can still disable them via
//   FF_<FLAG>=false.
// - Advanced/experimental features remain InDev (default false): LLM triage,
//   swarm mode, goal mode, notification subscriptions, triage automation, and
//   permanent board deletion.
registerFlag(FF_ENABLE_KANBAN_DISPATCH, true);
registerFlag(FF_WORKER_LOG_CAPTURE, true);
registerFlag(FF_SCHEDULED_STATUS, true);
registerFlag(FF_REVIEW_STATUS, true);
registerFlag(FF_COMPLETE_METADATA, true);
registerFlag(FF_PRIORITY_INTEGER, true);
registerFlag(FF_MAX_RUNTIME, true);
registerFlag(FF_SKILLS_ARRAY, true);
registerFlag(FF_TENANT_NAMESPACE, true);
registerFlag(FF_CREATED_BY, true);
registerFlag(FF_MODEL_OVERRIDE, true);
registerFlag(FF_MAX_RETRIES, true);
registerFlag(FF_BOARD_METADATA, true);
registerFlag(FF_BOARD_RM_DELETE, false);
registerFlag(FF_BOARD_RENAME, true);
registerFlag(FF_BOARD_RENAME_HERMES, true);
registerFlag(FF_BOARD_SWITCH, true);
registerFlag(FF_BOARD_CREATE_SWITCH, true);
registerFlag(FF_DEFAULT_WORKDIR, true);
registerFlag(FF_ASSIGN_REASSIGN, true);
registerFlag(FF_CRASH_GRACE_PERIOD, true);
registerFlag(FF_HEARTBEAT, true);
registerFlag(FF_RATE_LIMIT_EXIT_CODE, true);
registerFlag(FF_STATS, true);
registerFlag(FF_GC, true);
registerFlag(FF_ASSIGNEES_LISTING, true);
registerFlag(FF_TASK_ATTACHMENTS, true);
registerFlag(FF_DIAGNOSTICS, true);
registerFlag(FF_CONTEXT_BUILDER, true);
registerFlag(FF_NOTIFY_SUBS, false);
registerFlag(FF_LIST_FILTERS_SORT, true);
registerFlag(FF_SHOW_RUN_FILTERING, true);
registerFlag(FF_RUNS_FILTERING, true);
registerFlag(FF_BULK_OPERATIONS, true);
registerFlag(FF_COMMENT_ENHANCEMENTS, true);
registerFlag(FF_DISPATCH_CONTROLS, true);
registerFlag(FF_WATCH_FILTERS, true);
registerFlag(FF_WORKFLOW_TEMPLATES, true);
registerFlag(FF_TRIAGE_AUTOMATION, false);
registerFlag(FF_SWARM_MODE, false);
registerFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
registerFlag(FF_GOAL_MODE, false);
registerFlag(FF_DISPATCH_ONCE, true);
registerFlag(FF_LINK_UNLINK, true);
registerFlag(FF_GLOBAL_BOARD, true);
registerFlag(FF_CREATE_PARENT, true);
registerFlag(FF_TAIL_NO_FOLLOW, true);
registerFlag(FF_HARNESS_CONTEXT, true);
registerFlag(FF_RESULT_SUMMARY, true);
registerFlag(FF_WORKTREE_HANDOFF, true);
registerFlag(FF_REAL_HARNESS_PROFILES, true);
