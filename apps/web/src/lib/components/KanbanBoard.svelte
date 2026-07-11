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
    selectable?: boolean;
    selected: Set<number>;
    onselect?: (id: number, checked: boolean) => void;
  }

  let { tasks, board, capabilities, selectable = false, selected, onselect }: Props = $props();

  const columns = $derived.by(() => {
    const map: Record<string, KanbanTask[]> = {};
    for (const status of STATUSES) map[status] = [];
    for (const task of tasks) {
      if (map[task.status]) map[task.status].push(task);
    }
    return map;
  });
</script>

<div class="kanban-board">
  {#each STATUSES as status}
    <KanbanColumn
      {status}
      label={statusLabel(status)}
      count={board.taskCounts[status] ?? 0}
      tasks={columns[status]}
      boardSlug={board.slug}
      {capabilities}
      {selectable}
      {selected}
      {onselect}
    />
  {/each}
</div>

<style>
  .kanban-board {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    gap: 18px;
    align-content: start;
  }

  @media (max-width: 768px) {
    .kanban-board {
      grid-template-columns: 1fr;
    }
  }
</style>

