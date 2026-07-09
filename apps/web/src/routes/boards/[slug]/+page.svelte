<script lang="ts">
  import BoardKanbanView from "$lib/components/BoardKanbanView.svelte";
  import BoardActions from "$lib/components/BoardActions.svelte";
  import type { FormResult, BoardRef } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const created = $derived(data.board ? new Date(data.board.createdAt * 1000).toLocaleString() : "");
  const isCurrent = $derived(data.board?.slug === data.currentSlug);
  const isArchived = $derived(data.board?.archivedAt !== null);
  const boardRef = $derived<BoardRef | undefined>(
    data.board ? { slug: data.board.slug, name: data.board.name, archived: isArchived } : undefined,
  );
  const title = $derived(data.error ? "Board not found" : data.board?.name || data.board?.slug || "Board");
  const formResult = $derived(form as FormResult | undefined);
</script>

<svelte:head>
  <title>{title} — kdi</title>
</svelte:head>

{#if data.error}
  <div class="stack-md">
    <h1>Board not found</h1>
    <p class="error">{data.error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else if data.board}
  <div class="stack-md">
    <div class="flex-between">
      <h1>
        {data.board.name || data.board.slug}
        {#if isArchived}
          <span class="badge">(archived)</span>
        {/if}
      </h1>
      <div class="actions">
        <a href="/dispatch?board={data.board.slug}" class="btn">Dispatch</a>
        <a href="/boards/{data.board.slug}/edit" class="btn btn--primary">Edit</a>
        <a href="/boards" class="btn">← Back to boards</a>
      </div>
    </div>

    <BoardActions board={boardRef!} current={isCurrent} flags={data.flags} form={formResult} />

    <dl class="board-detail">
      <div class="detail-row">
        <dt>Slug</dt>
        <dd><code>{data.board.slug}</code></dd>
      </div>
      <div class="detail-row">
        <dt>Name</dt>
        <dd>{data.board.name}</dd>
      </div>
      {#if data.flags.boardMetadata}
        {#if data.board.icon}
          <div class="detail-row">
            <dt>Icon</dt>
            <dd>{data.board.icon}</dd>
          </div>
        {/if}
        {#if data.board.color}
          <div class="detail-row">
            <dt>Color</dt>
            <dd>
              <span class="color-swatch" style:background-color={data.board.color} title={data.board.color}></span>
            </dd>
          </div>
        {/if}
        {#if data.board.description}
          <div class="detail-row">
            <dt>Description</dt>
            <dd>{data.board.description}</dd>
          </div>
        {/if}
      {/if}
      <div class="detail-row">
        <dt>Workdir</dt>
        <dd><code>{data.board.workdir}</code></dd>
      </div>
      {#if data.flags.defaultWorkdir && data.board.defaultWorkdir}
        <div class="detail-row">
          <dt>Default workdir</dt>
          <dd><code>{data.board.defaultWorkdir}</code></dd>
        </div>
      {/if}
      <div class="detail-row">
        <dt>Base ref</dt>
        <dd><code>{data.board.baseRef}</code></dd>
      </div>
      <div class="detail-row">
        <dt>Created</dt>
        <dd>{created}</dd>
      </div>
    </dl>

    <h2 class="stack-sm">Task counts</h2>
    <div class="status-counts">
      {#each Object.entries(data.board.taskCounts) as [status, count]}
        <span class="status-count">{status}: {count}</span>
      {/each}
    </div>

    <!-- KDI-UI-003: Kanban board view as the main content of the board page. -->
    <BoardKanbanView {...data} />
  </div>
{/if}

<style>
  .board-detail {
    display: grid;
    gap: 8px;
    margin: 0 0 16px;
    padding: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .detail-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 12px;
    align-items: baseline;
  }
  .detail-row dt {
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
  }
  .detail-row dd {
    margin: 0;
  }
  @media (max-width: 768px) {
    .detail-row {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>

