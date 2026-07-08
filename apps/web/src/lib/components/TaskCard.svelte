<script lang="ts">
  import { formatAge, formatRemaining, isStale, isRateLimited, type KanbanTask, type KanbanCapabilities } from "$lib/kanban";

  interface Props {
    task: KanbanTask;
    boardSlug: string;
    capabilities: KanbanCapabilities;
  }

  let { task, boardSlug, capabilities }: Props = $props();

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

<a class="task-card" href={`/boards/${boardSlug}/tasks/${task.id}`}>
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

