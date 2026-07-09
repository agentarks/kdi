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

