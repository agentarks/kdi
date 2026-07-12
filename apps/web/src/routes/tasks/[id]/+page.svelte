<script lang="ts">
  import TaskDetailPanel from "$lib/components/TaskDetailPanel.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{data.detail?.task.title ?? "Task"} — kdi</title>
</svelte:head>

<TaskDetailPanel detail={data.detail} flags={data.flags} lifecycle={data.lifecycle} boardSlug={data.boardSlug} currentProfile={data.currentProfile} initialAction={data.initialAction} />