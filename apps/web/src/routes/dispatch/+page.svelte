<script lang="ts">
  import { page } from "$app/state";
  import type { PageProps } from "./$types";
  import type { DispatchStatus, DispatchOnceResult } from "$lib/types";
  import { clampInterval } from "$lib/pollInterval";

  let { data }: PageProps = $props();

  let liveStatus = $state<DispatchStatus | undefined>(undefined);
  let liveError = $state<string | undefined>(undefined);
  let liveLastRefreshed = $state<Date | null>(null);
  let result = $state<DispatchOnceResult | null>(null);
  let submitError = $state<string | null>(null);
  let loading = $state(false);
  let bootstrapping = $state(false);
  let pollInterval = $state(5);
  let forceBootstrap = $state(false);

  // Clamp poll interval to [2, 30] whenever it changes (e.g., user input).
  $effect(() => {
    const clamped = clampInterval(pollInterval);
    if (clamped !== pollInterval) {
      pollInterval = clamped;
    }
  });

  // Sync server data back into local state when the board changes (e.g., client-side navigation).
  // This prevents stale status, error, or result from the previous board.
  $effect(() => {
    liveStatus = data.status;
    liveError = data.error;
    liveLastRefreshed = data.status ? new Date() : null;
    result = null;
    submitError = null;
  });

  let max = $state(0);
  let failureLimit = $state<number | null>(null);
  let rateLimitCooldown = $state<string | null>(null);

  const board = $derived(data.board);
  const flags = $derived(data.flags ?? { canDispatch: false, canUseFailureLimit: false, canUseRateLimitCooldown: false, canShowProfiles: false });
  const boardSlug = $derived(page.url.searchParams.get("board") ?? board?.slug ?? "default");
  const boardName = $derived(board?.name || board?.slug || boardSlug);
  const pollIntervalMs = $derived(pollInterval * 1000);
  // Fall back to SSR data for the initial render so the server and client paint the same content.
  const status = $derived(liveStatus ?? data.status);
  const error = $derived(liveError ?? data.error);
  const lastRefreshed = $derived(liveLastRefreshed ?? (data.status ? new Date() : null));
  const pageTitle = $derived(
    error ? "Board not found — Dispatch — kdi" : boardName ? `${boardName} — Dispatch — kdi` : "Dispatch — kdi",
  );

  async function loadStatus() {
    if (!board) return;
    const res = await fetch(`/api/boards/${boardSlug}/dispatch/status`);
    if (!res.ok) {
      const payload = await res.json().catch(() => ({ message: "Failed to load status" }));
      liveError = payload.message ?? "Failed to load status";
      return;
    }
    liveStatus = (await res.json()) as DispatchStatus;
    liveLastRefreshed = new Date();
    liveError = undefined;
  }

  $effect(() => {
    if (typeof document === "undefined") return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadStatus();
      }
    }, pollIntervalMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") loadStatus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  async function runDispatch(e: SubmitEvent) {
    e.preventDefault();
    if (!board || !flags.canDispatch) return;
    submitError = null;
    result = null;
    loading = true;
    const body: { max: number; failureLimit?: number; rateLimitCooldown?: string } = { max };
    if (flags.canUseFailureLimit && failureLimit !== null && failureLimit > 0) {
      body.failureLimit = failureLimit;
    }
    if (flags.canUseRateLimitCooldown && rateLimitCooldown !== null && rateLimitCooldown.trim() !== "") {
      body.rateLimitCooldown = rateLimitCooldown.trim();
    }
    const res = await fetch(`/api/boards/${boardSlug}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    loading = false;
    const payload = await res.json().catch(() => ({ message: "Dispatch failed" }));
    if (!res.ok) {
      submitError = payload.message ?? "Dispatch failed";
      return;
    }
    result = payload as DispatchOnceResult;
    await loadStatus();
  }

  async function bootstrapProfiles() {
    if (!board) return;
    bootstrapping = true;
    submitError = null;
    const res = await fetch(`/api/boards/${boardSlug}/dispatch/profiles/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: forceBootstrap }),
    });
    bootstrapping = false;
    const payload = await res.json().catch(() => ({ message: "Bootstrap failed" }));
    if (!res.ok) {
      submitError = payload.message ?? "Bootstrap failed";
      return;
    }
    if (liveStatus) {
      liveStatus.profiles.entries = payload.profiles;
    }
    await loadStatus();
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#if error}
  <div class="stack-md">
    <h1>Board not found</h1>
    <p class="error" aria-live="polite">{error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else if board && status}
  <div class="stack-md">
    <div class="flex-between">
      <div>
        <h1>{boardName} — Dispatch</h1>
        <p class="text-dim" aria-live="polite" aria-atomic="true">
          Last refreshed: {lastRefreshed ? lastRefreshed.toLocaleTimeString() : "—"}
          {#if status.presence.present}
            <span class="badge">Running</span>
          {/if}
        </p>
        <p class="sr-only" aria-live="polite" aria-atomic="true">
          {status ? `Status updated: dispatcher ${status.presence.present ? "running" : "not detected"}; ready ${status.taskCounts.ready}, running ${status.taskCounts.running}` : ""}
        </p>
      </div>
      <div class="actions">
        <label class="interval" for="poll-interval">
          Poll
          <input
            id="poll-interval"
            name="poll-interval"
            type="number"
            min={2}
            max={30}
            bind:value={pollInterval}
          />
          s
        </label>
        <button class="btn" type="button" onclick={loadStatus} disabled={loading}>Refresh</button>
        <a href="/boards/{boardSlug}" class="btn">← Back to board</a>
      </div>
    </div>

    <div class="dispatch-grid">
      <section class="card">
        <h2 class="stack-sm">Dispatcher presence</h2>
        <div class="presence-row">
          {#if status.presence.present}
            <span class="badge">Running</span>
          {:else}
            <span class="badge warn">Not detected</span>
          {/if}
          <span class="text-dim">checked {new Date(status.presence.checkedAt * 1000).toLocaleTimeString()}</span>
        </div>
        {#if status.presence.present && status.presence.pid}
          <p class="text-dim">PID: <code>{status.presence.pid}</code></p>
        {/if}
      </section>

      <section class="card">
        <h2 class="stack-sm">Task counts</h2>
        <div class="counts-grid">
          {#each Object.entries(status.taskCounts) as [statusKey, count]}
            <div class="count-cell" class:emphasis={statusKey === "ready" || statusKey === "running"}>
              <span class="count-value">{count}</span>
              <span class="count-label">{statusKey}</span>
            </div>
          {/each}
        </div>
      </section>

      {#if flags.canShowProfiles}
        <section class="card">
          <h2 class="stack-sm">Profile health</h2>
          <p class="text-dim">{status.profiles.path}</p>
          <ul class="profile-list">
            {#each status.profiles.entries as profile}
              <li class="profile-row">
                <span class="profile-name">{profile.name}</span>
                <span class="text-dim">{profile.binary}</span>
                {#if profile.ok}
                  <span class="badge">ok</span>
                {:else}
                  <span class="badge warn">missing binary</span>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="actions stack-sm">
            <label class="inline-checkbox">
              <input type="checkbox" bind:checked={forceBootstrap} />
              Force bootstrap
            </label>
            <button class="btn btn--primary" type="button" onclick={bootstrapProfiles} disabled={bootstrapping}>
              {bootstrapping ? "Bootstrapping…" : "Bootstrap profiles"}
            </button>
            {#if !status.profiles.entries.every((p) => p.ok)}
              <p class="text-dim hint">Run bootstrap to repair missing profiles.</p>
            {/if}
          </div>
        </section>
      {/if}

      <section class="card">
        <h2 class="stack-sm">Recent spawn failures</h2>
        {#if status.recentFailures.failures.length === 0}
          <p class="placeholder-text">No recent spawn or crash failures.</p>
        {:else}
          <ul class="failure-list">
            {#each status.recentFailures.failures as failure}
              <li class="failure-row">
                <a href="/boards/{boardSlug}/tasks/{failure.taskId}">#{failure.taskId}</a>
                <span class="failure-title">{failure.taskTitle}</span>
                <span class="badge {failure.outcome === 'crashed' ? 'warn' : 'rate-limited'}">{failure.outcome}</span>
                <span class="text-dim">{failure.profile ?? "—"}</span>
                <span class="text-dim">{new Date(failure.startedAt * 1000).toLocaleString()}</span>
                {#if failure.error}
                  <p class="error small">{failure.error}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="card form-card">
        <h2 class="stack-sm">One-shot dispatch</h2>
        {#if !flags.canDispatch}
          <p class="error">One-shot dispatch is disabled. Enable <code>FF_ENABLE_KANBAN_DISPATCH</code> and <code>FF_DISPATCH_ONCE</code>.</p>
        {/if}
        <form onsubmit={runDispatch}>
          <div class="form-group">
            <label for="max">max</label>
            <input id="max" name="max" type="number" min={0} step={1} bind:value={max} disabled={!flags.canDispatch} />
            <span class="text-dim">0 = unlimited</span>
          </div>
          {#if flags.canUseFailureLimit}
            <div class="form-group">
              <label for="failureLimit">failure-limit</label>
              <input id="failureLimit" name="failureLimit" type="number" min={1} bind:value={failureLimit} disabled={!flags.canDispatch} />
            </div>
          {/if}
          {#if flags.canUseRateLimitCooldown}
            <div class="form-group">
              <label for="rateLimitCooldown">rate-limit-cooldown</label>
              <input id="rateLimitCooldown" name="rateLimitCooldown" type="text" placeholder="60s" bind:value={rateLimitCooldown} disabled={!flags.canDispatch} />
            </div>
          {/if}
          {#if status.taskCounts.ready === 0}
            <p class="text-dim hint">No tasks are ready to dispatch.</p>
          {/if}
          <button class="btn btn--primary" type="submit" disabled={!flags.canDispatch || loading}>
            {loading ? "Dispatching…" : "Run one-shot dispatch"}
          </button>
        </form>
        {#if submitError}
          <p class="error stack-sm" aria-live="polite">{submitError}</p>
        {/if}
        {#if result}
          <div class="result stack-sm" aria-live="polite" aria-atomic="true">
            <h3>Result</h3>
            <div class="result-grid">
              <div><span class="count-value">{result.processed}</span> processed</div>
              <div><span class="count-value">{result.spawned}</span> spawned</div>
              <div><span class="count-value warn">{result.blocked}</span> blocked</div>
              <div><span class="count-value">{result.skipped}</span> skipped</div>
              <div><span class="count-value warn">{result.failed}</span> failed</div>
            </div>
          </div>
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .dispatch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 18px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: 16px;
  }
  .card h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 12px;
  }
  .presence-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .counts-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .count-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .count-cell.emphasis {
    background: var(--accent-muted);
  }
  .count-value {
    font-size: 18px;
    font-weight: 700;
  }
  .count-label {
    font-size: 12px;
    color: var(--text-dim);
    text-transform: lowercase;
  }
  .profile-list,
  .failure-list {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
  }
  .profile-row,
  .failure-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .profile-row:last-child,
  .failure-row:last-child {
    border-bottom: none;
  }
  .profile-name {
    font-weight: 600;
    min-width: 100px;
  }
  .failure-title {
    font-weight: 500;
    flex: 1;
  }
  .failure-row .small {
    width: 100%;
    margin: 0;
    font-size: 12px;
  }
  .placeholder-text {
    color: var(--text-dim);
    font-style: italic;
  }
  .form-card form {
    max-width: 420px;
  }
  .inline-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .result {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .result h3 {
    font-size: 14px;
    margin: 0 0 8px;
  }
  .result-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 8px;
  }
  .interval {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .interval input {
    width: 50px;
    padding: 4px 6px;
  }
  .hint {
    margin: 8px 0 0;
  }
  @media (max-width: 768px) {
    .dispatch-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
