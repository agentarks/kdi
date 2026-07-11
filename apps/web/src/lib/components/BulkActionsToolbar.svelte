<script lang="ts">
  import Dialog from "$lib/components/Dialog.svelte";
  import { invalidateAll } from "$app/navigation";
  import type { LifecycleFlags, LifecycleAction, LifecycleResult, LifecycleFields, BulkLifecycleResult } from "$lib/types";

  interface Props {
    boardSlug: string;
    selected: number[];
    flags: LifecycleFlags;
    onclear: () => void;
  }
  let { boardSlug, selected, flags, onclear }: Props = $props();

  const BULK_BUTTONS: { action: LifecycleAction; label: string }[] = [
    { action: "promote", label: "Promote" },
    { action: "block", label: "Block" },
    { action: "unblock", label: "Unblock" },
    { action: "schedule", label: "Schedule" },
    { action: "archive", label: "Archive" },
    { action: "complete", label: "Complete" },
  ];

  let dialog = $state<Dialog | undefined>(undefined);
  let active = $state<LifecycleAction | null>(null);
  let busy = $state(false);
  let bulkResult = $state<BulkLifecycleResult | null>(null);

  let reason = $state("");
  let atLocal = $state("");
  let resultText = $state("");
  let force = $state(false);
  let dryRun = $state(false);
  let confirmChecked = $state(false);

  function resetFields() {
    reason = ""; atLocal = ""; resultText = ""; force = false; dryRun = false; confirmChecked = false;
  }

  function open(action: LifecycleAction) {
    resetFields();
    active = action;
    dialog?.open();
  }

  function toUnix(local: string): number {
    return Math.floor(new Date(local).getTime() / 1000);
  }

  function fieldsFor(action: LifecycleAction): LifecycleFields {
    switch (action) {
      case "promote": return { force, dryRun };
      case "block": return { reason };
      case "unblock": return { reason: reason || undefined };
      case "schedule": return { at: toUnix(atLocal), reason: reason || undefined };
      case "archive": return {};
      case "complete": return { result: resultText || undefined };
    }
    return {};
  }

  async function submit() {
    if (!active || busy) return;
    busy = true;
    try {
      const res = await fetch(`/api/boards/${boardSlug}/tasks/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: active, taskIds: selected, fields: fieldsFor(active) }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        bulkResult = data as BulkLifecycleResult;
        // Only mutating (non-dry-run) runs change state.
        if (!(active === "promote" && dryRun)) await invalidateAll();
        dialog?.close();
      } else {
        bulkResult = {
          results: selected.map((id) => ({ taskId: id, status: "error", message: data.message ?? `Request failed (${res.status})` })),
          summary: { attempted: selected.length, succeeded: 0, skipped: 0, failed: selected.length },
        };
        dialog?.close();
      }
    } finally {
      busy = false;
    }
  }

  const canSchedule = $derived(flags.scheduledStatus);
  // FR-9/FR-10: reject past times client-side before calling the model.
  const atInPast = $derived(atLocal !== "" && toUnix(atLocal) <= Math.floor(Date.now() / 1000));
</script>

<div class="bulk-toolbar">
  <span class="bulk-count">{selected.length} selected</span>
  {#each BULK_BUTTONS as btn (btn.action)}
    <button
      type="button"
      class="btn"
      disabled={btn.action === "schedule" && !canSchedule}
      title={btn.action === "schedule" && !canSchedule ? "FF_SCHEDULED_STATUS" : undefined}
      onclick={() => open(btn.action)}
    >
      {btn.label}
    </button>
  {/each}
  <button type="button" class="btn" onclick={onclear}>Clear</button>

  {#if bulkResult}
    <div class="bulk-result">
      <div class="summary">
        <span class="badge">attempted {bulkResult.summary.attempted}</span>
        <span class="badge success-count">succeeded {bulkResult.summary.succeeded}</span>
        <span class="badge">skipped {bulkResult.summary.skipped}</span>
        <span class="badge warn">failed {bulkResult.summary.failed}</span>
        <button type="button" class="btn" onclick={() => (bulkResult = null)}>Dismiss</button>
      </div>
      <ul class="result-list">
        {#each bulkResult.results as r (r.taskId)}
          <li class="result-row {r.status}">
            <strong>#{r.taskId}</strong>
            <span class="result-status">{r.status}</span>
            <span>{r.message}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<Dialog bind:this={dialog} title={active ? `Bulk ${active}` : ""}>
  {#if active === "promote"}
    <label class="check"><input type="checkbox" bind:checked={dryRun} /> Dry run (preview per task)</label>
    <label class="check"><input type="checkbox" bind:checked={force} /> Force (bypass parent dependencies)</label>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Promote {selected.length}</button>
    </div>
  {:else if active === "block"}
    <div class="form-group"><label for="bulk-block-reason">Reason (required, applies to all)</label>
      <textarea id="bulk-block-reason" bind:value={reason} rows="3"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !reason.trim()}>Block {selected.length}</button>
    </div>
  {:else if active === "unblock"}
    <div class="form-group"><label for="bulk-unblock-reason">Reason (optional)</label>
      <textarea id="bulk-unblock-reason" bind:value={reason} rows="2"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Unblock {selected.length}</button>
    </div>
  {:else if active === "schedule"}
    <div class="form-group"><label for="bulk-sched-at">At (required, future, applies to all)</label>
      <input id="bulk-sched-at" type="datetime-local" bind:value={atLocal} /></div>
      {#if atLocal && atInPast}<span class="error">Scheduled time must be in the future.</span>{/if}
    <div class="form-group"><label for="bulk-sched-reason">Reason (optional)</label>
      <textarea id="bulk-sched-reason" bind:value={reason} rows="2"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !atLocal || atInPast}>Schedule {selected.length}</button>
    </div>
  {:else if active === "archive"}
    <p class="stack-sm warn-text">Archive {selected.length} task(s)? This is one-way — no UI restore exists.</p>
    <label class="check"><input type="checkbox" bind:checked={confirmChecked} /> I understand this is permanent</label>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !confirmChecked}>Archive {selected.length}</button>
    </div>
  {:else if active === "complete"}
    <div class="form-group"><label for="bulk-complete-result">Result (optional, applies to all)</label>
      <input id="bulk-complete-result" type="text" bind:value={resultText} /></div>
    <p class="stack-sm text-dim">Bulk complete supports only a result field.</p>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Complete {selected.length}</button>
    </div>
  {/if}
</Dialog>

<style>
  .bulk-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .bulk-count {
    font-weight: 700;
    font-family: var(--font-ui);
    font-size: 13px;
    margin-right: 4px;
  }
  .bulk-result {
    flex-basis: 100%;
    margin-top: 4px;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .badge.success-count { background: var(--success); color: var(--surface); }
  .badge.warn { background: var(--warning); color: var(--warning-text); }
  .result-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 240px;
    overflow: auto;
  }
  .result-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 12px;
    background: var(--surface);
  }
  .result-row.success { background: var(--accent-muted); }
  .result-row.skipped { color: var(--text-dim); }
  .result-row.error { background: var(--warning); color: var(--warning-text); }
  .result-status {
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-ui);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .warn-text { color: var(--warning-text); font-size: 13px; }
</style>
