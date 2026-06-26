<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  import { page } from "$app/state";

  const boardSlug = $derived(page.url.searchParams.get("board") ?? "default");
</script>

<h1 style="margin: 0 0 16px;">Board: {boardSlug}</h1>

<Placeholder
  title="Kanban board view"
  note="KDI-UI-003 will render the 9 statuses, counts, and filters by calling kdi models from +server.ts (KDI-UI-001)."
>
  <p>Shell only for now. Use the CLI to inspect this board:</p>
  <pre><code>kdi boards show --board {boardSlug}</code></pre>
</Placeholder>