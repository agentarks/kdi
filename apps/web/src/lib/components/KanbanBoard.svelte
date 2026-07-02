
<script lang="ts">
  import KanbanColumn from "$lib/components/KanbanColumn.svelte";
  import { STATUSES, statusLabel, type KanbanTask, type KanbanCapabilities } from "$lib/kanban";

  interface Props {
    tasks: KanbanTask[];
    board: {
      slug: string;
      taskCounts: Record<string, number>;
    };
    capabilities: KanbanCapabilities;
  }

  let { tasks, board, capabilities }: Props = $props();

  function columns(): Record<string, KanbanTask[]> {
    const map: Record<string, KanbanTask[]> = {};
    for (const status of STATUSES) map[status] = [];
    for (const task of tasks) {
      if (map[task.status]) map[task.status].push(task);
    }
    return map;
  }
</script>

<div class="kanban-board">
  {#each STATUSES as status}
    <KanbanColumn
      {status}
      label={statusLabel(status)}
      count={board.taskCounts[status] ?? 0}
      tasks={columns()[status]}
      boardSlug={board.slug}
      {capabilities}
    />
  {/each}
</div>

<style>
  .kanban-board {
    display: grid;
    grid-template-columns: repeat(9, minmax(16rem, 1fr));
    gap: 0.75rem;
    overflow-x: auto;
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
