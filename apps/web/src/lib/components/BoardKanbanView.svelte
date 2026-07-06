<script lang="ts">
  import KanbanFilterBar from "$lib/components/KanbanFilterBar.svelte";
  import KanbanBoard from "$lib/components/KanbanBoard.svelte";
  import type { KanbanTask, KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";

  interface Props {
    board: {
      id: number;
      slug: string;
      name: string | null;
      workdir: string;
      baseRef: string;
      archivedAt: number | null;
      taskCounts: Record<string, number>;
    };
    tasks: KanbanTask[];
    filters: KanbanFilterState;
    assignees: Record<string, number>;
    profiles: string[];
    templates: KanbanTemplate[];
    currentProfile: string;
    capabilities: KanbanCapabilities;
  }

  let { board, tasks, filters, assignees, profiles, templates, currentProfile, capabilities }: Props = $props();

  const displayBoard = $derived({
    ...board,
    taskCounts: filters.archived
      ? board.taskCounts
      : { ...board.taskCounts, archived: 0 },
  });
</script>

<div class="board-view">
  <header class="board-header">
    <h1>Board: {board.name ?? board.slug}</h1>
    {#if board.archivedAt !== null}
      <span class="archived-tag">archived</span>
    {/if}
    <span class="board-meta">{board.workdir} · {board.baseRef}</span>
  </header>

  <KanbanFilterBar
    {filters}
    {assignees}
    {profiles}
    {templates}
    {currentProfile}
    {capabilities}
  />

  <KanbanBoard {tasks} board={displayBoard} {capabilities} />
</div>

<style>
  .board-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: 100%;
  }
  .board-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .board-header h1 {
    margin: 0;
    font-size: 1.25rem;
  }
  .archived-tag {
    font-size: 0.75rem;
    text-transform: uppercase;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    background: var(--color-muted, #e5e7eb);
    color: var(--color-muted-text, #4b5563);
  }
  .board-meta {
    font-size: 0.85rem;
    color: var(--color-dim, #6b7280);
  }
</style>
