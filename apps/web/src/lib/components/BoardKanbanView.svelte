<script lang="ts">
  import KanbanFilterBar from "$lib/components/KanbanFilterBar.svelte";
  import KanbanBoard from "$lib/components/KanbanBoard.svelte";
  import BulkActionsToolbar from "$lib/components/BulkActionsToolbar.svelte";
  import type { KanbanTask, KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";
  import type { LifecycleFlags } from "$lib/types";

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
    lifecycle: LifecycleFlags;
  }

  let { board, tasks, filters, assignees, profiles, templates, currentProfile, capabilities, lifecycle }: Props = $props();

  const displayBoard = $derived({
    ...board,
    taskCounts: filters.archived
      ? board.taskCounts
      : { ...board.taskCounts, archived: 0 },
  });

  // Bulk-selection state lives here so it survives filter/poll refreshes.
  let selected = $state<Set<number>>(new Set());
  const selectable = $derived(!!capabilities.bulkOperations);
  const selectedArr = $derived([...selected].sort((a, b) => a - b));

  function toggle(id: number, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    selected = next;
  }
  function clearSelection() {
    selected = new Set();
  }
</script>

<div class="board-view">
  <header class="board-view-header">
    <h1>Board: {board.name ?? board.slug}</h1>
    {#if board.archivedAt !== null}
      <span class="badge archived-tag">archived</span>
    {/if}
    <span class="board-meta">{board.workdir} · {board.baseRef}</span>
  </header>

  {#if selectable && selected.size > 0}
    <BulkActionsToolbar boardSlug={board.slug} selected={selectedArr} flags={lifecycle} onclear={clearSelection} />
  {/if}

  <KanbanFilterBar
    {filters}
    {assignees}
    {profiles}
    {templates}
    {currentProfile}
    {capabilities}
  />

  <KanbanBoard {tasks} board={displayBoard} {capabilities} {selectable} {selected} onselect={toggle} />
</div>

<style>
  .board-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
  }
  .board-view-header {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .board-view-header h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
  }
  .board-meta {
    font-size: 13px;
    color: var(--text-dim);
  }
</style>

