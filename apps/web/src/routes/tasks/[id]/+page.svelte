<script lang="ts">
  import TaskDetailPanel from "$lib/components/TaskDetailPanel.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.error ? "Task not found" : `${data.detail?.task.title ?? "Task"} — kdi`}</title>
</svelte:head>

{#if data.error}
  <div class="stack-md">
    <h1>Task not found</h1>
    <p class="error">{data.error}</p>
    {#if data.boardSlug}
      <p><a href="/boards/{data.boardSlug}">← Back to board</a></p>
    {/if}
  </div>
{:else if data.detail}
  <TaskDetailPanel detail={data.detail} flags={data.flags} boardSlug={data.boardSlug} />
{/if}
