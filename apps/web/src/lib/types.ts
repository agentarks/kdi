// UI-facing types shared between the SvelteKit components and the server-side
// data bridge. Kept outside $lib/server so client components can import them
// without crossing the server-only module boundary.

export interface BoardRef {
  slug: string;
  name: string;
  archived: boolean;
}

export interface BoardListRow extends BoardRef {
  id: number;
  icon: string | null;
  color: string | null;
  description: string | null;
  workdir: string;
  defaultWorkdir: string | null;
  baseRef: string;
  createdAt: number;
  statusCounts: Record<string, number>;
}

export interface BoardFlags {
  boardMetadata: boolean;
  boardCreateSwitch: boolean;
  defaultWorkdir: boolean;
  boardSwitch: boolean;
  boardRenameHermes: boolean;
  boardRename: boolean;
  boardRmDelete: boolean;
}

export interface ActivityFlags {
  watchFilters: boolean;
  tailNoFollow: boolean;
  workerLogCapture: boolean;
  tenantNamespace: boolean;
}

// Dispatch Control Center (KDI-UI-007)

export interface DispatchPresence {
  present: boolean;
  pid: number | null;
  checkedAt: number;
}

export interface ProfileHealth {
  name: string;
  agent: string | undefined;
  command: string;
  binary: string;
  resolvedPath: string | null;
  ok: boolean;
  status: "ok" | "missing-binary";
}

export interface SpawnFailure {
  runId: number;
  taskId: number;
  taskTitle: string;
  profile: string | null;
  outcome: "spawn_failed" | "crashed" | "failed";
  error: string | null;
  startedAt: number;
}

export interface DispatchFlags {
  canDispatch: boolean;
  canUseFailureLimit: boolean;
  canUseRateLimitCooldown: boolean;
  canShowProfiles: boolean;
}

export interface TaskCounts {
  triage: number;
  todo: number;
  scheduled: number;
  ready: number;
  running: number;
  blocked: number;
  review: number;
  done: number;
  archived: number;
}

export interface DispatchStatus {
  board: string;
  presence: DispatchPresence;
  taskCounts: TaskCounts;
  profiles: {
    enabled: boolean;
    path: string;
    entries: ProfileHealth[];
  };
  recentFailures: {
    enabled: boolean;
    failures: SpawnFailure[];
  };
  flags: DispatchFlags;
}

export interface DispatchOnceResult {
  processed: number;
  spawned: number;
  blocked: number;
  skipped: number;
  failed: number;
}

export interface FormResult {
  error?: string;
  intent?: string;
  slug?: string;
  success?: boolean;
  values?: Record<string, unknown>;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  runId: number | null;
  kind: string;
  payload: string | null;
  createdAt: number;
}

export interface TaskSummary {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: number;
  tenant: string | null;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TaskDetailTask {
  id: number;
  boardId: number;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  tenant: string | null;
  workspaceKind: string;
  workspace: string | null;
  branch: string | null;
  result: string | null;
  summary: string | null;
  blockReason: string | null;
  scheduleReason: string | null;
  reviewReason: string | null;
  createdBy: string;
  skills: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  archivedAt: number | null;
  currentRunId: number | null;
  claimLock: string | null;
  claimExpires: number | null;
  lastHeartbeatAt: number | null;
  maxRuntimeSeconds: number | null;
  maxRetries: number | null;
  consecutiveFailures: number;
  idempotencyKey: string | null;
  modelOverride: string | null;
  rateLimitedUntil: number | null;
  scheduledAt: number | null;
  sessionId: string | null;
  workflowTemplateId: string | null;
  currentStepKey: string | null;
  swarmParentId: number | null;
  goalMode: boolean;
  goalMaxTurns: number | null;
  goalRemainingTurns: number | null;
  goalJudgeProfile: string | null;
}

export interface TaskDetailComment {
  id: number;
  taskId: number;
  text: string;
  author: string | null;
  createdAt: number;
}

export interface TaskDetailAttachment {
  id: number;
  taskId: number;
  filename: string;
  storedPath: string;
  contentType: string | null;
  size: number;
  uploadedBy: string | null;
  createdAt: number;
}

export interface TaskDetailRun {
  id: number;
  taskId: number;
  profile: string | null;
  stepKey: string | null;
  status: string;
  claimLock: string | null;
  claimExpires: number | null;
  workerPid: number | null;
  maxRuntimeSeconds: number | null;
  lastHeartbeatAt: number | null;
  startedAt: number;
  spawnedAt: number | null;
  endedAt: number | null;
  outcome: string | null;
  summary: string | null;
  metadata: string | null;
  error: string | null;
}

export interface TaskDetailEvent {
  id: number;
  taskId: number;
  runId: number | null;
  kind: string;
  payload: string | null;
  createdAt: number;
}

export interface TaskLog {
  present: boolean;
  content?: string;
  path?: string;
}

export interface TaskDetailContext {
  taskId: number;
  title: string;
  assignee?: string;
  status: string;
  priority: number;
  tenant?: string;
  createdBy?: string;
  body: string;
  parents: Array<{ taskId: number; title: string; result: string; summary: string }>;
  olderParentsOmitted: number;
  priorAttempts: Array<{
    runId: number;
    profile: string | null;
    status: string;
    outcome: string | null;
    summary: string;
    error: string;
    startedAt: number;
    endedAt: number | null;
  }>;
  olderAttemptsOmitted: number;
  roleHistory: Array<{ at: number; event: string; actor: string; note: string | null }>;
  olderRoleHistoryOmitted: number;
  comments: Array<{ id: number; author: string; text: string; createdAt: number }>;
  olderCommentsOmitted: number;
  attachments: Array<{ filename: string; absolutePath: string }>;
}

export interface TaskDetailHandoff {
  branch: string;
  worktreePath: string;
  eventAt: number;
}

export interface TaskDetail {
  task: TaskDetailTask;
  parents: TaskSummary[];
  children: TaskSummary[];
  handoff: TaskDetailHandoff | null;
  log: { present: boolean; path: string };
  runs: TaskDetailRun[];
  events: TaskDetailEvent[];
  comments: TaskDetailComment[];
  attachments: TaskDetailAttachment[];
  context: TaskDetailContext | null;
  contextError?: string;
}

export interface DetailFlags {
  sveltekitFrontend: boolean;
  contextBuilder: boolean;
  taskAttachments: boolean;
  showRunFiltering: boolean;
  workerLogCapture: boolean;
  commentEnhancements: boolean;
  goalMode: boolean;
  workflowTemplates: boolean;
  heartbeat: boolean;
  maxRuntime: boolean;
  maxRetries: boolean;
  rateLimitExitCode: boolean;
  scheduledStatus: boolean;
  skillsArray: boolean;
  modelOverride: boolean;
  createdBy: boolean;
  tenantNamespace: boolean;
  resultSummary: boolean;
  worktreeHandoff: boolean;
  priorityInteger: boolean;
}

export interface LogResponse {
  present: boolean;
  content?: string;
  path?: string;
  truncated?: boolean;
  size?: number;
  disabled?: boolean;
}

export interface DependenciesResponse {
  parents: TaskSummary[];
  children: TaskSummary[];
}

export interface HandoffResponse {
  present: boolean;
  branch?: string;
  worktreePath?: string;
  eventAt?: number;
}
