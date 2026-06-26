<script lang="ts">
  let { title, note, children }: { title: string; note?: string; children?: import("svelte").Snippet } = $props();
</script>

<div class="placeholder">
  <h2 style="margin: 0 0 8px;">{title}</h2>
  {#if note}<p style="margin: 0 0 12px; color: var(--text-dim);">{note}</p>{/if}
  {#if children}{@render children()}{/if}
</div>