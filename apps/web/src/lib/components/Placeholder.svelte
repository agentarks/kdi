<script lang="ts">
  let { title, note, children }: { title: string; note?: string; children?: import("svelte").Snippet } = $props();
</script>

<div class="placeholder">
  <h2 class="stack-xs">{title}</h2>
  {#if note}<p class="stack-sm text-dim">{note}</p>{/if}
  {#if children}{@render children()}{/if}
</div>