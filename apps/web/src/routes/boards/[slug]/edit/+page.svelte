
<script lang="ts">
  import BoardMetadataFields from "$lib/components/BoardMetadataFields.svelte";
  import type { FormResult } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const formResult = $derived(form as FormResult | undefined);
  const values = $derived(formResult?.values ?? {});
  const board = $derived(data.board);
</script>

<svelte:head>
  <title>Edit {board?.name ?? board?.slug ?? "board"} — kdi</title>
</svelte:head>

{#if data.error}
  <div class="stack-md">
    <h1>Board not found</h1>
    <p class="error">{data.error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else if board}
  <h1 class="stack-md">Edit {board.name || board.slug}</h1>

  <h2 class="stack-sm">Metadata</h2>
  <form method="POST" action="/boards/{board.slug}/edit?/metadata">
    <BoardMetadataFields
      name={(values.name as string) ?? board.name}
      icon={(values.icon as string) ?? (board.icon ?? "")}
      color={(values.color as string) ?? (board.color ?? "")}
      description={(values.description as string) ?? (board.description ?? "")}
      flags={data.flags}
    />

    {#if formResult?.error && values.workdir === undefined}
      <p class="error">{formResult.error}</p>
    {/if}

    <div class="stack-sm">
      <button type="submit" class="btn btn--primary" disabled={!data.flags.boardMetadata}>
        Update metadata
      </button>
    </div>
  </form>

  <h2 class="stack-sm">Default workdir</h2>
  <form method="POST" action="/boards/{board.slug}/edit?/defaultWorkdir">
    <div class="form-group">
      <label for="workdir">Default task workspace</label>
      <input
        id="workdir"
        name="workdir"
        type="text"
        value={(values.workdir as string) ?? (board.defaultWorkdir ?? "")}
        disabled={!data.flags.defaultWorkdir}
        title={!data.flags.defaultWorkdir ? "FF_DEFAULT_WORKDIR" : undefined}
      />
      <p class="text-dim">Leave empty to clear the default workdir.</p>
    </div>

    {#if formResult?.error && values.workdir !== undefined}
      <p class="error">{formResult.error}</p>
    {/if}

    <div class="stack-sm">
      <button type="submit" class="btn btn--primary" disabled={!data.flags.defaultWorkdir}>
        Set default workdir
      </button>
    </div>
  </form>

  <p><a href="/boards/{board.slug}">← Back to board</a></p>
{/if}
