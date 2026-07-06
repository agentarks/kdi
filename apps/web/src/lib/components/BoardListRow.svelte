<script lang="ts">
  import BoardActions from "$lib/components/BoardActions.svelte";
  import type { BoardListRow, BoardFlags, FormResult } from "$lib/types";

  interface Props {
    board: BoardListRow;
    current: boolean;
    flags: BoardFlags;
    form?: FormResult;
  }
  let { board, current, flags, form }: Props = $props();

  const displayName = $derived(board.name || board.slug);
  const description = $derived(board.description ?? undefined);
</script>

<tr class="board-row" class:archived={board.archived}>
  <td>
    <a href="/boards/{board.slug}">{displayName}</a>
    {#if current}
      <span class="badge">Current</span>
    {/if}
    {#if board.archived}
      <span class="badge archived-tag">Archived</span>
    {/if}
  </td>
  <td><code>{board.slug}</code></td>
  <td>{board.icon ?? "—"}</td>
  <td>
    {#if board.color}
      <span class="color-swatch" role="img" aria-label="Board color {board.color}" style:background-color={board.color} title={board.color}></span>
    {:else}
      —
    {/if}
  </td>
  <td title={description}>
    {#if description}
      {description.length > 60 ? description.slice(0, 60) + "…" : description}
    {:else}
      —
    {/if}
  </td>
  <td><code>{board.workdir}</code></td>
  <td><code>{board.baseRef}</code></td>
  <td>
    <div class="status-counts">
      {#each Object.entries(board.statusCounts) as [status, count]}
        <span class="status-count" title={status}>{status}: {count}</span>
      {/each}
    </div>
  </td>
  <td>
    <BoardActions {board} {current} {flags} {form} />
  </td>
</tr>

<style>
  .badge.archived-tag {
    background: #ff6b6b;
    color: #0b1220;
  }
</style>
