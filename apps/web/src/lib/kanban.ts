import type { KanbanTask as BridgeKanbanTask } from "$lib/server/bridge";

export type KanbanTask = BridgeKanbanTask;

export interface KanbanFilterState {
  status: string | null;
  assignee: string | null;
  mine: boolean;
  tenant: string | null;
  createdBy: string | null;
  sessionId: string | null;
  archived: boolean;
  workflowTemplateId: string | null;
  stepKey: string | null;
  sort: string;
}

export interface KanbanCapabilities {
  listFiltersSort: boolean;
  tenantNamespace: boolean;
  createdBy: boolean;
  assigneesListing: boolean;
  workflowTemplates: boolean;
  rateLimitExitCode: boolean;
  heartbeat: boolean;
}

export interface KanbanTemplate {
  id: number;
  templateId: string;
  name: string;
  steps: string[];
}

export const STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
] as const;

export type Status = (typeof STATUSES)[number];

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatAge(seconds: number, now = Date.now() / 1000): string {
  const diff = now - seconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function formatRemaining(seconds: number, now = Date.now() / 1000): string {
  const diff = seconds - now;
  if (diff <= 0) return "now";
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function isStale(
  task: {
    status: string;
    updatedAt: number;
    lastHeartbeatAt: number | null;
  },
  heartbeatEnabled: boolean,
  now = Date.now() / 1000,
): boolean {
  const STALE_UPDATE_SECONDS = 24 * 3600;
  const STALE_HEARTBEAT_SECONDS = 60 * 60;
  if (task.status === "running" && heartbeatEnabled && task.lastHeartbeatAt !== null) {
    if (now - task.lastHeartbeatAt > STALE_HEARTBEAT_SECONDS) return true;
  }
  if (task.status !== "done" && task.status !== "archived") {
    if (now - task.updatedAt > STALE_UPDATE_SECONDS) return true;
  }
  return false;
}

export function isRateLimited(
  task: { rateLimitedUntil: number | null },
  now = Date.now() / 1000,
): task is { rateLimitedUntil: number } {
  return task.rateLimitedUntil !== null && task.rateLimitedUntil > now;
}

export const VALID_SORT_KEYS = [
  "assignee",
  "created",
  "created-desc",
  "priority",
  "priority-desc",
  "status",
  "title",
  "updated",
] as const;

export type SortKey = (typeof VALID_SORT_KEYS)[number];
