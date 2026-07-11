<script lang="ts">
  import { formatAge, formatRemaining, isStale, isRateLimited, type KanbanTask, type KanbanCapabilities } from "$lib/kanban";

  interface Props {
    task: KanbanTask;
    boardSlug: string;
    capabilities: KanbanCapabilities;
    selectable?: boolean;
    selected?: boolean;
    onselect?: (id: number, checked: boolean) => void;
  }

  let { task, boardSlug, capabilities, selectable = false, selected = false, onselect }: Props = $props();

  function stale(): boolean {
    return isStale(task, capabilities.heartbeat);
  }
  function rateLimited(): boolean {
    return isRateLimited(task);
  }
  function age(): string {
    return formatAge(task.createdAt);
  }
</script>

<div class="task-card" class:selected>
  {#if selectable}
    <input
      type="checkbox"
      class="card-check"
      checked={selected}
      aria-label="Select task #{task.id}"
      onchange={(e) => onselect?.(task.id, e.currentTarget.checked)}
    />
  {/if}
  <a class="card-body" href={`/tasks/${task.id}?board=${boardSlug}`}>
    <div class="card-header">
      <span class="task-id">#{task.id}</span>
      <span class="priority" title="Priority">{task.priority}</span>
    </div>
    <h3 class="task-title">{task.title}</h3>
    <div class="card-meta">
      <span class="assignee">{task.assignee ?? "unassigned"}</span>
      <span class="age" title="Created">{age()}</span>
    </div>
    {#if task.tenant && capabilities.tenantNamespace}
      <span class="badge tenant">{task.tenant}</span>
    {/if}
    {#if task.createdBy && capabilities.createdBy}
      <span class="badge created-by" title="Created by">@{task.createdBy}</span>
    {/if}
    {#if task.blockReason && task.status === "blocked"}
      <span class="badge reason" title={task.blockReason}><span aria-hidden="true">🚫</span> blocked</span>
    {/if}
    {#if task.scheduleReason && task.status === "scheduled"}
      <span class="badge reason" title={task.scheduleReason}>
        <span aria-hidden="true">⏳</span>
        {task.scheduledAt !== null ? `scheduled ${formatRemaining(task.scheduledAt)}` : "scheduled"}
      </span>
    {/if}
    {#if task.reviewReason && task.status === "review"}
      <span class="badge reason" title={task.reviewReason}><span aria-hidden="true">👁</span> review</span>
    {/if}
    {#if stale()}
      <span class="badge stale">stale</span>
    {/if}
    {#if rateLimited() && capabilities.rateLimitExitCode}
      <span class="badge rate-limited" title={`Until ${formatRemaining(task.rateLimitedUntil!)}`}>rate limited</span>
    {/if}
  </a>
</div>

<style>
  .task-card {
    display: flex;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    color: var(--text);
    font-size: 13px;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .task-card:hover {
    transform: translate(1px, 1px);
    box-shadow: var(--shadow-hover);
  }
  .task-card.selected {
    background: var(--accent-muted);
    box-shadow: inset 0 0 0 2px var(--border), var(--shadow-sm);
  }
  .card-check {
    margin: 0;
    width: 16px;
    height: 16px;
    accent-color: var(--border);
    flex-shrink: 0;
    cursor: pointer;
  }
  .card-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-decoration: none;
    color: inherit;
    flex: 1;
    min-width: 0;
  }
  .card-body:hover {
    text-decoration: none;
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .task-id {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .priority {
    font-weight: 700;
    font-size: 12px;
  }
  .task-title {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.45;
  }
  .card-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-dim);
    font-size: 12px;
  }
  .assignee {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
