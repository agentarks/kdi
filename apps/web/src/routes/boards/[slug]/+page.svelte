
<script lang="ts">
  import BoardKanbanView from "$lib/components/BoardKanbanView.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{data.board?.name ?? data.board?.slug ?? "Board"} — kdi</title>
</svelte:head>

{#if data.board}
  <BoardKanbanView {...data} />
{:else}
  <p>Board not found.</p>
{/if}
