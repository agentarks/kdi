<script lang="ts">
  import TaskCard from "$lib/components/TaskCard.svelte";
  import type { KanbanTask, KanbanCapabilities } from "$lib/kanban";

  interface Props {
    status: string;
    label: string;
    count: number;
    tasks: KanbanTask[];
    boardSlug: string;
    capabilities: KanbanCapabilities;
  }

  let { status, label, count, tasks, boardSlug, capabilities }: Props = $props();
</script>

<div class="kanban-column" data-status={status}>
  <header class="column-header">
    <span class="column-title">{label}</span>
    <span class="column-count">{count}</span>
  </header>
  <div class="column-cards">
    {#each tasks as task (task.id)}
      <TaskCard {task} {capabilities} {boardSlug} />
    {/each}
  </div>
</div>

<style>
  .kanban-column {
    display: flex;
    flex-direction: column;
    min-width: 16rem;
    background: var(--color-surface, #f9fafb);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .column-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: var(--color-muted, #e5e7eb);
    font-weight: 600;
  }
  .column-count {
    font-size: 0.85rem;
    color: var(--color-dim, #6b7280);
  }
  .column-cards {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    overflow-y: auto;
  }
</style>
