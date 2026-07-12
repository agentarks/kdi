<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    children: Snippet;
  }
  let { title, children }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  // Stable unique ID so aria-labelledby resolves to this dialog's heading.
  const titleId = `dialog-title-${crypto.randomUUID()}`;

  export function open() {
    dialog?.showModal();
  }
  export function close() {
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby={titleId} aria-modal="true">
  <div class="dialog-content">
    <h3 class="stack-sm" id={titleId}>{title}</h3>
    {@render children()}
  </div>
</dialog>
