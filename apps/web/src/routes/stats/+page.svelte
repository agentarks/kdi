<script lang="ts">
  // KDI-UI-009 Slice 1: read-only /stats page.
  import type { PageProps } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { formatDuration } from "$lib/format";
  import type { StatsFlags } from "$lib/types";

  interface BoardStats {
    board: string;
    statusCounts: Record<string, number>;
    assigneeCounts: Record<string, number>;
    oldestReadyAgeSeconds: number | null;
  }

  let { data }: PageProps = $props();

  const flags = $derived(data.flags as StatsFlags);
  const board = $derived(data.board);
  const stats = $derived(data.stats as BoardStats | undefined);
  const statuses = $derived(
    (data.statuses as readonly string[] | undefined) ?? [
      "triage",
      "todo",
      "scheduled",
      "ready",
      "running",
      "done",
      "blocked",
      "review",
    ],
  );
  const snapshotAt = $derived(data.snapshotAt as number | undefined);
  const error = $derived(data.error as string | undefined);
  const boardSlug = $derived(board?.slug ?? (data.boardSlug as string | undefined) ?? "");

  // Refresh re-runs the loader on the same URL (FR-7).
  async function refresh() {
    await invalidateAll();
  }

  // JSON export (FR-8): the stats payload from boardStatsJson (same source as
  // `kdi stats --json`). Triggered as a client download so no new server route.
  function exportJson() {
    if (!stats) return;
    const blob = new Blob([JSON.stringify(stats, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stats-${boardSlug || "board"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head>
  <title>Stats — kdi</title>
</svelte:head>

{#if !data.enabled}
  <!-- FR-2 / AC-11: disabled message, no error. -->
  <div class="stack-md">
    <h1>Stats</h1>
    <p class="text-dim">Stats feature is not enabled.</p>
    <p class="text-dim">Enable it with <code>FF_STATS=true</code>.</p>
  </div>
{:else if error}
  <!-- FR-1: board-not-found inline error. -->
  <div class="stack-md">
    <h1>Stats</h1>
    <p class="error">{error}</p>
    <p><a class="btn" href="/boards">← Back to boards</a></p>
  </div>
{:else if board && stats}
  <div class="stack-md">
    <div class="flex-between">
      <div>
        <h1>Stats</h1>
        <p class="text-dim">
          Board: <code>{board.name || board.slug}</code>
          {#if snapshotAt}
            <span class="dim-sep">·</span>
            snapshot {new Date(snapshotAt).toLocaleString()}
          {/if}
        </p>
      </div>
      <div class="actions">
        <button class="btn" type="button" onclick={refresh}>Refresh</button>
        <button class="btn btn--primary" type="button" onclick={exportJson}>Export JSON</button>
      </div>
    </div>

    <!-- FR-4: status counts (zeros explicit). Each row links to the board view. -->
    <section aria-labelledby="status-heading">
      <h2 id="status-heading" class="stack-sm">Status counts</h2>
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {#each statuses as status (status)}
            <tr>
              <td>
                <a
                  class="status-link"
                  href="/boards/{board.slug}?status={status}"
                >{status}</a>
              </td>
              <td class="count">{stats.statusCounts[status] ?? 0}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <!-- FR-5: assignee counts (ready/running load), empty-state. -->
    <section aria-labelledby="assignee-heading">
      <h2 id="assignee-heading" class="stack-sm">Assignee counts (ready / running)</h2>
      {#if Object.keys(stats.assigneeCounts).length === 0}
        <div class="placeholder">No assigned ready/running tasks</div>
      {:else}
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Assignee</th>
              <th scope="col">Tasks</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(stats.assigneeCounts) as [assignee, count] (assignee)}
              <tr>
                <td>
                  <a
                    class="status-link"
                    href="/boards/{board.slug}?assignee={encodeURIComponent(assignee)}"
                  >{assignee}</a>
                </td>
                <td class="count">{count}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    <!-- FR-6: oldest ready age (human-readable; null-state). -->
    <section aria-labelledby="oldest-heading">
      <h2 id="oldest-heading" class="stack-sm">Oldest ready age</h2>
      <p class="oldest">
        {#if stats.oldestReadyAgeSeconds === null}
          <span class="text-dim">No ready tasks</span>
        {:else}
          <span class="badge">{formatDuration(stats.oldestReadyAgeSeconds)}</span>
          <span class="text-dim">({stats.oldestReadyAgeSeconds}s)</span>
        {/if}
      </p>
    </section>
  </div>
{:else}
  <div class="stack-md">
    <h1>No board selected</h1>
    <p class="text-dim">
      Choose a board from the switcher or <a href="/boards">view all boards</a>.
    </p>
  </div>
{/if}

<style>
  .count {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .status-link {
    text-transform: lowercase;
    font-family: var(--font-mono);
  }
  .oldest {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dim-sep {
    color: var(--text-dim);
    margin: 0 4px;
  }
</style>
