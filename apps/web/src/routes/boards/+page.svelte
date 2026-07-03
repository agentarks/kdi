<script lang="ts">
  import BoardListRow from "$lib/components/BoardListRow.svelte";
  import { page } from "$app/state";
  import type { FormResult } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data, form: rawForm }: PageProps = $props();
  const form = $derived(rawForm as FormResult | undefined);

  const success = $derived(form?.success ? "Action succeeded" : undefined);
  const querySuccess = $derived(page.url.searchParams.get("success"));
</script>

<svelte:head>
  <title>Boards — kdi</title>
</svelte:head>

<div class="stack-md">
  <div class="flex-between">
    <h1>Boards</h1>
    <a href="/boards/new" class="btn btn--primary">Create board</a>
  </div>

  {#if success || querySuccess}
    <p class="success">{success || querySuccess}</p>
  {/if}

  {#if form?.error && !form?.slug}
    <p class="error">{form.error}</p>
  {/if}
</div>

<div class="stack-sm">
  <a href="/boards{data.includeArchived ? '' : '?includeArchived=true'}" class="btn">
    {data.includeArchived ? "Hide archived" : "Include archived"}
  </a>
</div>

{#if data.boards.length === 0}
  <div class="placeholder">
    <p class="stack-sm">No boards found.</p>
    <p>
      Run <code>kdi init</code> or <a href="/boards/new">create a board</a> to get started.
    </p>
  </div>
{:else}
  <table class="table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Slug</th>
        <th>Icon</th>
        <th>Color</th>
        <th>Description</th>
        <th>Workdir</th>
        <th>Base ref</th>
        <th>Counts</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each data.boards as board (board.slug)}
        <BoardListRow
          {board}
          current={board.slug === data.currentSlug}
          flags={data.flags}
          form={form}
        />
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .flex-between {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
</style>
