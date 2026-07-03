<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    children: Snippet;
  }
  let { title, children }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);

  export function open() {
    dialog?.showModal();
  }
  export function close() {
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="dialog">
  <div class="dialog-content">
    <h3 class="stack-sm">{title}</h3>
    {@render children()}
  </div>
</dialog>
