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
  <header class="board-view-header">
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

