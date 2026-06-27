<script lang="ts">
  import Placeholder from "$lib/components/Placeholder.svelte";
  import { page } from "$app/state";

  // ponytail: single catch-all placeholder for the unbuilt nav views
  // (tasks/dispatch/activity/stats). When a real view lands (KDI-UI-002+),
  // its explicit route shadows this catch-all automatically.
  const path = $derived(page.url.pathname.replace(/^\//, "") || "index");
  const label = $derived(path.charAt(0).toUpperCase() + path.slice(1));
</script>

<Placeholder
  title="{label} — coming soon"
  note="This view is part of the SvelteKit UI backlog and not implemented yet. See specs/sveltekit-ui-backlog.md."
/>