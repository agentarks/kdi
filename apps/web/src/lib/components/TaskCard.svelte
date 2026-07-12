<script lang="ts">
  import { formatAge, formatRemaining, isStale, isRateLimited, type KanbanTask, type KanbanCapabilities } from "$lib/kanban";
  import type { LifecycleFlags, LifecycleAction } from "$lib/types";
  import { ROW_ACTIONS, canPerform, actionTooltip, postTaskAction } from "$lib/lifecycle";
  import { invalidateAll } from "$app/navigation";

  interface Props {
    task: KanbanTask;
    boardSlug: string;
    capabilities: KanbanCapabilities;
    lifecycle: LifecycleFlags;
    selectable?: boolean;
    selected?: boolean;
    onselect?: (id: number, checked: boolean) => void;
  }

  let { task, boardSlug, capabilities, lifecycle, selectable = false, selected = false, onselect }: Props = $props();

  function stale(): boolean {
    return isStale(task, capabilities.heartbeat);
  }
  function rateLimited(): boolean {
    return isRateLimited(task);
  }
  function age(): string {
    return formatAge(task.createdAt);
  }

  // Row action menu state
  let pendingAction = $state<LifecycleAction | null>(null);
  let fieldValue = $state("");
  let busy = $state(false);
  let rowResult = $state<string | null>(null);

  function openField(action: LifecycleAction) {
    const def = ROW_ACTIONS.find((r) => r.action === action);
    if (!def?.needsField) {
      void fire(action);
      return;
    }
    pendingAction = action;
    fieldValue = "";
  }

  async function fire(action: LifecycleAction, fields: Record<string, unknown> = {}) {
    busy = true;
    try {
      const { ok, result } = await postTaskAction(boardSlug, task.id, action, fields);
      rowResult = `${result.status}: ${result.message}`;
      if (ok && result.status !== "skipped") await invalidateAll();
    } finally {
      busy = false;
      pendingAction = null;
      setTimeout(() => (rowResult = null), 4000);
    }
  }

  function submitField() {
    if (!pendingAction || busy) return;
    const def = ROW_ACTIONS.find((r) => r.action === pendingAction);
    if (def?.needsField === "reason") void fire(pendingAction, { reason: fieldValue });
    else if (def?.needsField === "datetime") {
      const at = Math.floor(new Date(fieldValue).getTime() / 1000);
      void fire(pendingAction, { at });
    } else if (def?.needsField === "profile") void fire(pendingAction, { profile: fieldValue });
  }

  const fieldPlaceholder = $derived(
    pendingAction === "block" ? "Reason (required)"
    : pendingAction === "schedule" ? "YYYY-MM-DDTHH:MM"
    : "Profile",
  );
  const fieldType = $derived(pendingAction === "schedule" ? "datetime-local" : pendingAction === "assign" || pendingAction === "reassign" ? "text" : "text");
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

  <details class="row-menu">
    <summary class="btn row-menu-trigger" aria-label="Actions for task #{task.id}">⋯</summary>
    <div class="row-menu-dropdown">
      {#if pendingAction}
        <div class="inline-field">
          <input type={fieldType} bind:value={fieldValue} placeholder={fieldPlaceholder} />
          <button type="button" class="btn btn--primary" onclick={submitField} disabled={busy || !fieldValue.trim()}>OK</button>
          <button type="button" class="btn" onclick={() => (pendingAction = null)}>Cancel</button>
        </div>
      {:else}
        {#each ROW_ACTIONS as item (item.action)}
          <button
            type="button"
            class="btn row-menu-item"
            disabled={!canPerform(item.action, task, lifecycle) || busy}
            title={actionTooltip(item.action, task, lifecycle)}
            onclick={() => openField(item.action)}
          >
            {item.label}
          </button>
        {/each}
      {/if}
    </div>
  </details>

  {#if rowResult}
    <p class="row-result" role="status" aria-live="polite">{rowResult}</p>
  {/if}
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
    flex-wrap: wrap;
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

  .row-menu {
    position: relative;
  }
  .row-menu[open] > summary {
    background: var(--accent-muted);
  }
  .row-menu-trigger {
    padding: 2px 8px;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
  }
  .row-menu-dropdown {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 10;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-lg);
    min-width: 200px;
    margin-top: 2px;
  }
  .row-menu-item {
    font-size: 12px;
    padding: 4px 10px;
    box-shadow: none;
    border: 1px solid var(--border);
    flex: 1;
    min-width: 80px;
  }
  .row-menu-item:hover:not(:disabled) {
    background: var(--accent-muted);
  }
  .inline-field {
    display: flex;
    gap: 4px;
    width: 100%;
    flex-wrap: wrap;
  }
  .inline-field input {
    flex: 1;
    min-width: 100px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: 12px;
    background: var(--surface);
  }
  .inline-field .btn {
    font-size: 12px;
    padding: 4px 10px;
  }
  .row-result {
    flex-basis: 100%;
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }
</style>
