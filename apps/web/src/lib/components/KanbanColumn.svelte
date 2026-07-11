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
    selectable?: boolean;
    selected: Set<number>;
    onselect?: (id: number, checked: boolean) => void;
  }

  let { status, label, count, tasks, boardSlug, capabilities, selectable = false, selected, onselect }: Props = $props();
</script>

<div class="kanban-column" data-status={status}>
  <header class="column-header">
    <span class="column-title">{label}</span>
    <span class="column-count">{count}</span>
  </header>
  <div class="column-cards">
    {#each tasks as task (task.id)}
      <TaskCard {task} {capabilities} {boardSlug} {selectable} selected={selected.has(task.id)} {onselect} />
    {/each}
  </div>
</div>

<style>
  .kanban-column {
    display: flex;
    flex-direction: column;
    min-width: 16rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    padding: 16px;
  }
  .column-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    font-weight: 600;
    font-size: 13px;
  }
  .column-count {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    background: var(--border);
    color: var(--surface);
    font-weight: 600;
  }
  .column-cards {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
</style>

