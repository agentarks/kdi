<script lang="ts">
  // Mirrors the server-side FF_SVELTEKIT_FRONTEND gate via the public Vite flag.
  // The server hook is the real authority; this badge is an operator indicator.
  const enabled = import.meta.env.VITE_FF_SVELTEKIT_FRONTEND === "true";
</script>

<span class="flag-badge" class:on={enabled}>
  FF_SVELTEKIT_FRONTEND={enabled ? "true" : "false"}
</span>