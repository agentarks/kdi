<script lang="ts">
  import Dialog from "$lib/components/Dialog.svelte";
  import type { BoardRef, BoardFlags, FormResult } from "$lib/types";

  interface Props {
    board: BoardRef;
    current: boolean;
    flags: BoardFlags;
    form?: FormResult;
  }
  let { board, current, flags, form }: Props = $props();

  let renameDialog = $state<Dialog | undefined>(undefined);
  let renameSlugDialog = $state<Dialog | undefined>(undefined);
  let archiveDialog = $state<Dialog | undefined>(undefined);
  let deleteDialog = $state<Dialog | undefined>(undefined);
  let confirmedSlug = $state("");

  const canRename = $derived(flags.boardRenameHermes);
  const canRenameSlug = $derived(flags.boardRename);
  const canSwitch = $derived(flags.boardSwitch);
  const canDelete = $derived(flags.boardRmDelete);
  const actionError = $derived(form?.slug === board.slug ? form.error : undefined);
</script>

<div class="board-actions">
  {#if current}
    <span class="badge">Current</span>
  {:else}
    <form method="POST" action="/boards/{board.slug}?/switch" class="inline-form">
      <button
        type="submit"
        class="btn"
        disabled={!canSwitch}
        title={!canSwitch ? "FF_BOARD_SWITCH" : undefined}
      >
        Make current
      </button>
    </form>
  {/if}

  <button
    type="button"
    class="btn"
    disabled={!canRename}
    title={!canRename ? "FF_BOARD_RENAME_HERMES" : undefined}
    onclick={() => renameDialog?.open()}
  >
    Rename
  </button>

  <button
    type="button"
    class="btn"
    disabled={!canRenameSlug}
    title={!canRenameSlug ? "FF_BOARD_RENAME" : undefined}
    onclick={() => renameSlugDialog?.open()}
  >
    Rename slug
  </button>

  <button
    type="button"
    class="btn"
    onclick={() => archiveDialog?.open()}
  >
    Archive
  </button>

  {#if canDelete}
    <button
      type="button"
      class="btn"
      onclick={() => deleteDialog?.open()}
    >
      Delete permanently
    </button>
  {/if}

  {#if actionError}
    <p class="error">{actionError}</p>
  {/if}
</div>

<Dialog bind:this={renameDialog} title="Rename board">
  <form method="POST" action="/boards/{board.slug}?/rename">
    <div class="form-group">
      <label for="rename-slug-{board.slug}">Slug</label>
      <input id="rename-slug-{board.slug}" type="text" value={board.slug} disabled />
    </div>
    <div class="form-group">
      <label for="rename-name-{board.slug}">Display name</label>
      <input
        id="rename-name-{board.slug}"
        name="name"
        type="text"
        value={board.name}
        required
      />
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => renameDialog?.close()}>Cancel</button>
      <button type="submit" class="btn btn--primary">Rename</button>
    </div>
  </form>
</Dialog>

<Dialog bind:this={renameSlugDialog} title="Rename board slug">
  <form method="POST" action="/boards/{board.slug}?/renameSlug">
    <p class="stack-sm">
      Renaming the slug moves the board data directory and may rewrite the current-board file.
    </p>
    <div class="form-group">
      <label for="rename-slug-old-{board.slug}">Current slug</label>
      <input id="rename-slug-old-{board.slug}" type="text" value={board.slug} disabled />
    </div>
    <div class="form-group">
      <label for="rename-slug-new-{board.slug}">New slug</label>
      <input
        id="rename-slug-new-{board.slug}"
        name="newSlug"
        type="text"
        required
      />
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => renameSlugDialog?.close()}>Cancel</button>
      <button type="submit" class="btn btn--primary">Rename slug</button>
    </div>
  </form>
</Dialog>

<Dialog bind:this={archiveDialog} title="Archive board">
  <form method="POST" action="/boards/{board.slug}?/archive">
    <p class="stack-sm">
      Archive <strong>{board.slug}</strong> ({board.name})? This is one-way; archived boards appear only when “Include archived” is on.
    </p>
    <input type="hidden" name="confirm" value="true" />
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => archiveDialog?.close()}>Cancel</button>
      <button type="submit" class="btn btn--primary">Archive</button>
    </div>
  </form>
</Dialog>

{#if canDelete}
  <Dialog bind:this={deleteDialog} title="Delete board permanently">
    <form method="POST" action="/boards/{board.slug}?/delete">
      <p class="stack-sm">
        Deleting <strong>{board.slug}</strong> ({board.name}) permanently removes:
      </p>
      <ul>
        <li>all tasks, runs, events, attachments, comments, and dependencies</li>
        <li>workflow templates for this board</li>
        <li>the on-disk board data directory</li>
      </ul>
      <div class="form-group">
        <label for="delete-confirm-{board.slug}">
          Type <strong>{board.slug}</strong> to confirm
        </label>
        <input
          id="delete-confirm-{board.slug}"
          name="confirmedSlug"
          type="text"
          bind:value={confirmedSlug}
        />
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" onclick={() => deleteDialog?.close()}>Cancel</button>
        <button
          type="submit"
          class="btn btn--primary"
          disabled={confirmedSlug !== board.slug}
        >
          Delete permanently
        </button>
      </div>
    </form>
  </Dialog>
{/if}
