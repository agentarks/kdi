<script lang="ts">
  // Shown when FF_SVELTEKIT_FRONTEND != "true". The server hook redirects here.
</script>

<div class="disabled-screen">
  <h1>SvelteKit UI is disabled</h1>
  <p>
    The operator UI is gated behind
    <code>FF_SVELTEKIT_FRONTEND</code>, which is currently <code>false</code>.
  </p>
  <p>
    Start the dev server with the flag on and an isolated database:
  </p>
  <pre><code>FF_SVELTEKIT_FRONTEND=true VITE_FF_SVELTEKIT_FRONTEND=true \
  KDI_DB=/tmp/kdi-ui.sqlite bun run dev:web</code></pre>
  <p>
    The kdi CLI is unaffected —
    <code>pulls the same SQLite data when the data bridge (KDI-UI-001) lands</code>.
  </p>
</div>