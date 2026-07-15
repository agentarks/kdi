<script lang="ts">
  import type { PageProps } from "./$types";
  import { browser } from "$app/environment";
  import { invalidateAll } from "$app/navigation";
  import { goto } from "$app/navigation";
  import DiagnosticActions from "$lib/components/DiagnosticActions.svelte";
  import type { DiagnosticsFlags } from "$lib/server/bridge";

  interface Finding {
    rule: string;
    severity: string;
    taskId: number;
    message: string;
    actions: string[];
  }

  let { data }: PageProps = $props();

  const flags = $derived(data.flags as DiagnosticsFlags);
  const error = $derived(data.error);
  const board = $derived(data.board);
  const findings = $derived((data.findings as Finding[] | undefined) ?? []);
  const currentSeverity = $derived(data.severity ?? "");
  const currentTask = $derived(data.taskId);

  const severityCounts = $derived({
    critical: findings.filter((f) => f.severity === "critical").length,
    error: findings.filter((f) => f.severity === "error").length,
    warning: findings.filter((f) => f.severity === "warning").length,
  });

  function boardName(): string {
    return board?.name || board?.slug || "";
  }

  // Severity filter: changing the <select> navigates to the new URL, which
  // re-runs the server loader with the chosen minimum severity.
  function applySeverity(e: Event) {
    const target = e.target as HTMLSelectElement;
    const url = new URL(window.location.href);
    if (target.value) url.searchParams.set("severity", target.value);
    else url.searchParams.delete("severity");
    goto(url.pathname + url.search);
  }

  async function refresh() {
    await invalidateAll();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(findings, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostics-${board?.slug ?? "board"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Maps a finding severity to a badge CSS class. Critical/error use the
  // warning token (red) for urgency; warning stays neutral.
  function severityClass(sev: string): string {
    if (sev === "critical" || sev === "error") return "sev-high";
    return "sev-low";
  }
</script>

<svelte:head>
  <title>Diagnostics — kdi</title>
</svelte:head>

{#if !flags.diagnostics}
  <!-- AC-12: disabled state — clear message instead of an error. -->
  <div class="stack-md">
    <h1>Diagnostics</h1>
    <div class="placeholder">Diagnostics feature is not enabled.</div>
  </div>
{:else if error}
  <div class="stack-md">
    <h1>Diagnostics</h1>
    {#if board}
      <p class="text-dim">Board: <code>{board.slug}</code></p>
    {/if}
    <p class="error" role="alert">{error}</p>
    <p><a href="/boards">&larr; Back to boards</a></p>
  </div>
{:else if board}
  <div class="stack-md">
    <div class="flex-between">
      <div>
        <h1>Diagnostics</h1>
        <p class="text-dim">Board: <code>{board.slug}</code></p>
      </div>
      <div class="actions">
        <button class="btn" type="button" onclick={refresh}>Refresh</button>
        <button class="btn" type="button" onclick={exportJson} disabled={!browser}>Export JSON</button>
      </div>
    </div>

    <!-- FR-11: total count + severity breakdown. -->
    <p class="text-dim">
      {findings.length} finding{findings.length === 1 ? "" : "s"}
      {#if severityCounts.critical}
        &middot; <span class="sev-high">{severityCounts.critical} critical</span>
      {/if}
      {#if severityCounts.error}
        &middot; <span class="sev-high">{severityCounts.error} error</span>
      {/if}
      {#if severityCounts.warning}
        &middot; {severityCounts.warning} warning
      {/if}
    </p>

    <!-- FR-12: severity filter (all / warning / error / critical). -->
    <div class="filters">
      <label class="form-group severity-filter">
        Severity
        <select value={currentSeverity} onchange={applySeverity}>
          <option value="">All</option>
          <option value="critical">Critical+</option>
          <option value="error">Error+</option>
          <option value="warning">Warning+</option>
        </select>
      </label>
    </div>

    <!-- FR-15: per-task filter indicator + back link. -->
    {#if currentTask !== undefined}
      <p class="text-dim">
        Task findings for <code>#{currentTask}</code>
        &middot;
        <a href="/diagnostics?board={board.slug}">Show all findings</a>
      </p>
    {/if}

    {#if findings.length === 0}
      <!-- FR-16: empty state. -->
      <div class="placeholder">No diagnostic findings.</div>
    {:else}
      <ul class="finding-list" role="list">
        {#each findings as f (f.rule + f.taskId)}
          <li class="finding">
            <div class="finding-head">
              <span class="badge {severityClass(f.severity)}">{f.severity}</span>
              <code class="finding-rule">{f.rule}</code>
              <!-- FR-21: task-id link preserves the board. -->
              <a href="/tasks/{f.taskId}?board={board.slug}">#{f.taskId}</a>
            </div>
            <p class="finding-msg">{f.message}</p>
            {#if f.actions.length > 0}
              <DiagnosticActions actions={f.actions} boardSlug={board.slug} taskId={f.taskId} />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <div class="stack-md">
    <h1>Diagnostics</h1>
    <p class="text-dim">No board selected. Choose a board from the switcher or <a href="/boards">view all boards</a>.</p>
  </div>
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
  }
  .severity-filter {
    margin-bottom: 0;
    max-width: 200px;
  }
  .finding-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .finding {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .finding-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .finding-rule {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 13px;
  }
  .finding-msg {
    margin: 4px 0 8px;
    font-size: 14px;
  }
  .sev-high {
    background: var(--warning);
    color: var(--warning-text);
  }
  .sev-low {
    background: var(--accent);
    color: var(--accent-text);
  }
</style>
