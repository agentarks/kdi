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

