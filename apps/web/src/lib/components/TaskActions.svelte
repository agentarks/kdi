<script lang="ts">
  import Dialog from "$lib/components/Dialog.svelte";
  import { invalidateAll } from "$app/navigation";
  import { canPerform, actionTooltip, postTaskAction } from "$lib/lifecycle";
  import type { TaskDetailTask, LifecycleFlags, LifecycleAction, LifecycleResult, LifecycleFields } from "$lib/types";

  interface Props {
    task: TaskDetailTask;
    flags: LifecycleFlags;
    boardSlug: string;
    currentProfile: string;
    hasBlockingDeps?: boolean;
    initialAction?: string | null;
  }
  let { task, flags, boardSlug, currentProfile, hasBlockingDeps = false, initialAction }: Props = $props();

  let dialog = $state<Dialog | undefined>(undefined);

  interface ActionButton {
    action: LifecycleAction;
    label: string;
  }

  const SINGLE_BUTTONS: ActionButton[] = [
    { action: "promote", label: "Promote" },
    { action: "block", label: "Block" },
    { action: "unblock", label: "Unblock" },
    { action: "schedule", label: "Schedule" },
    { action: "review", label: "Review" },
    { action: "claim", label: "Claim" },
    { action: "reclaim", label: "Reclaim" },
    { action: "assign", label: "Assign" },
    { action: "reassign", label: "Reassign" },
    { action: "heartbeat", label: "Heartbeat" },
    { action: "complete", label: "Complete" },
    { action: "archive", label: "Archive" },
  ];
  const SINGLE_LIFECYCLE_ACTIONS_FROM_LABEL = new Set(SINGLE_BUTTONS.map((b) => b.action));
  let active = $state<LifecycleAction | null>(null);
  let busy = $state(false);
  let result = $state<LifecycleResult | null>(null);
  let dialogError = $state<string | null>(null);

  // Heartbeat note byte counter. TextEncoder measures true UTF-8 bytes so CJK /
  // emoji input is bounded by the real 4 KiB budget, not JS code-unit count.
  const encoder = new TextEncoder();

  // form fields (reset on each open)
  let reason = $state("");
  let atLocal = $state("");
  let profile = $state("");
  let reclaim = $state(false);
  let ttl = $state("");
  let note = $state("");
  let resultText = $state("");
  let summary = $state("");
  let metadata = $state("");
  let force = $state(false);
  let confirmChecked = $state(false);
  let dryRunResult = $state<LifecycleResult | null>(null);

  // Per-action enable conditions (FR-27). Client gating is UX only; the server
  // re-checks. Disabled controls get a flag/status tooltip.
  function can(action: LifecycleAction): boolean { return canPerform(action, task, flags); }
  function tooltip(action: LifecycleAction): string | undefined { return actionTooltip(action, task, flags); }

  function resetFields() {
    reason = ""; atLocal = ""; profile = ""; reclaim = false; ttl = "";
    note = ""; resultText = ""; summary = ""; metadata = "";
    force = false; confirmChecked = false; dryRunResult = null;
    dialogError = null;
  }

  function open(action: LifecycleAction) {
    resetFields();
    // FR-16: assign defaults to the current user; reassign shows the existing
    // assignee so the operator sees the current state before changing it.
    if (action === "assign") profile = currentProfile;
    else if (action === "reassign") profile = task.assignee ?? currentProfile;
    active = action;
    dialog?.open();
  }

  // Row menu opens detail with ?action=X; auto-open on mount.
  $effect(() => {
    if (initialAction && SINGLE_LIFECYCLE_ACTIONS_FROM_LABEL.has(initialAction as LifecycleAction)) {
      const action = initialAction as LifecycleAction;
      if (canPerform(action, task, flags)) open(action);
    }
  });

  function fieldsFor(action: LifecycleAction, dry: boolean): LifecycleFields {
    switch (action) {
      case "promote": return { force, dryRun: dry };
      case "block": return { reason };
      case "unblock": return { reason: reason || undefined };
      case "schedule": return { at: toUnix(atLocal), reason: reason || undefined };
      case "review": return { reason: reason || undefined };
      case "archive": return {};
      case "complete": return { result: resultText || undefined, summary: summary || undefined, metadata: flags.completeMetadata && metadata ? metadata : undefined };
      case "assign": return { profile };
      case "reassign": return { profile, reclaim, reason: reason || undefined };
      case "claim": return { profile: profile || undefined, ttl: ttl ? Number(ttl) : undefined };
      case "reclaim": return { reason: flags.assignReassign && reason ? reason : undefined };
      case "heartbeat": return { note: note || undefined };
    }
    return {};
  }

  function toUnix(local: string): number {
    // datetime-local → seconds. Empty/invalid → NaN, server rejects.
    return Math.floor(new Date(local).getTime() / 1000);
  }

  async function post(fields: LifecycleFields): Promise<{ ok: boolean; result: LifecycleResult }> {
    return postTaskAction(boardSlug, task.id, active!, fields);
  }

  async function submit() {
    if (!active || busy) return;
    busy = true;
    try {
      const { ok, result: r } = await post(fieldsFor(active, false));
      result = r;
      // On error, keep the dialog open and surface the message in-dialog
      // (role="alert") so the operator can see/recover from 4xx validation
      // errors instead of having them render only behind the modal.
      if (!ok || r.status === "error") {
        dialogError = r.message;
        return;
      }
      dialogError = null;
      if (r.status !== "skipped") await invalidateAll();
      dialog?.close();
    } finally {
      busy = false;
    }
  }

  async function runDryRun() {
    if (!active || busy) return;
    busy = true;
    try {
      const { result: r } = await post(fieldsFor("promote", true));
      dryRunResult = r;
    } finally {
      busy = false;
    }
  }

  const noteBytes = $derived(encoder.encode(note).length);
  const noteOver = $derived(noteBytes > 4096);

  // FR-9: the UI rejects times in the past before calling the model.
  const atInPast = $derived(atLocal !== "" && toUnix(atLocal) <= Math.floor(Date.now() / 1000));
</script>

<section class="detail-section" aria-labelledby="actions-heading">
  <h2 id="actions-heading">Actions</h2>

  {#if result}
    <p class="result-row {result.status}" role="status" aria-live="polite">
      <strong>#{result.taskId}</strong>
      <span class="result-status">{result.status}</span>
      <span>{result.message}</span>
    </p>
  {/if}
  {#if busy}
    <p class="busy" role="status" aria-live="polite">Working…</p>
  {/if}

  <div class="action-grid">
    {#each SINGLE_BUTTONS as btn (btn.action)}
      {@const enabled = can(btn.action)}
      <button
        type="button"
        class="btn"
        aria-disabled={!enabled}
        title={tooltip(btn.action)}
        aria-describedby={!enabled && tooltip(btn.action) ? `action-desc-${btn.action}` : undefined}
        onclick={() => { if (enabled) open(btn.action); }}
      >
        {btn.label}
      </button>
    {/each}
  </div>
  <!-- a11y: disabled (aria-disabled) buttons stay keyboard-focusable so the
       reason is reachable; each disabled action exposes its reason via a
       visually-hidden description referenced by aria-describedby. -->
  <div class="sr-only">
    {#each SINGLE_BUTTONS as btn (btn.action)}
      {#if !can(btn.action) && tooltip(btn.action)}
        <span id={`action-desc-${btn.action}`}>{tooltip(btn.action)}</span>
      {/if}
    {/each}
  </div>
</section>

<Dialog bind:this={dialog} title={active ? SINGLE_BUTTONS.find((b) => b.action === active)?.label ?? active : ""}>
  {#if dialogError}
    <p class="dialog-error" role="alert">{dialogError}</p>
  {/if}
  {#if active === "promote"}
    {#if flags.bulkOperations}
      <label class="check">
        <input
          type="checkbox"
          bind:checked={force}
          disabled={!hasBlockingDeps}
          title={hasBlockingDeps ? undefined : "Enabled when a parent dependency is blocking"}
        />
        Force (bypass parent dependencies)
      </label>
      {#if !hasBlockingDeps}
        <p class="text-dim hint">No parent dependencies blocking this task; force is not needed.</p>
      {/if}
    {:else}
      <p class="text-dim hint">Force requires FF_BULK_OPERATIONS.</p>
    {/if}
    {#if dryRunResult}
      <p class="result-row {dryRunResult.status}" role="status" aria-live="polite">Dry run: {dryRunResult.message}</p>
    {/if}
    <div class="dialog-actions">
      {#if flags.bulkOperations}
        <button type="button" class="btn" onclick={runDryRun} disabled={busy}>Dry run</button>
      {/if}
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Promote</button>
    </div>
  {:else if active === "block"}
    <div class="form-group"><label for="block-reason">Reason (required)</label>
      <textarea id="block-reason" bind:value={reason} rows="3"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !reason.trim()}>Block</button>
    </div>
  {:else if active === "unblock"}
    <div class="form-group"><label for="unblock-reason">Reason (optional)</label>
      <textarea id="unblock-reason" bind:value={reason} rows="2"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Unblock</button>
    </div>
  {:else if active === "schedule"}
    <div class="form-group"><label for="sched-at">At (required, future)</label>
      <input id="sched-at" type="datetime-local" bind:value={atLocal} /></div>
      {#if atLocal && atInPast}<span class="error">Scheduled time must be in the future.</span>{/if}
    <div class="form-group"><label for="sched-reason">Reason (optional)</label>
      <textarea id="sched-reason" bind:value={reason} rows="2"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !atLocal || atInPast}>Schedule</button>
    </div>
  {:else if active === "review"}
    <div class="form-group"><label for="review-reason">Reason (optional)</label>
      <textarea id="review-reason" bind:value={reason} rows="2"></textarea></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Review</button>
    </div>
  {:else if active === "archive"}
    <p class="stack-sm warn-text">Archive <strong>#{task.id} {task.title}</strong>? This is one-way; no UI restore exists.</p>
    <label class="check"><input type="checkbox" bind:checked={confirmChecked} /> I understand this is permanent</label>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !confirmChecked}>Archive</button>
    </div>
  {:else if active === "complete"}
    <div class="form-group"><label for="complete-result">Result (optional)</label>
      <input id="complete-result" type="text" bind:value={resultText} /></div>
    <div class="form-group"><label for="complete-summary">Summary (optional)</label>
      <input id="complete-summary" type="text" bind:value={summary} /></div>
    {#if flags.completeMetadata}
      <div class="form-group"><label for="complete-metadata">Metadata JSON (optional)</label>
        <textarea id="complete-metadata" bind:value={metadata} rows="2"></textarea></div>
    {/if}
    <p class="stack-sm warn-text">Completing finalizes the task and its run.</p>
    <label class="check"><input type="checkbox" bind:checked={confirmChecked} /> Confirm completion</label>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !confirmChecked}>Complete</button>
    </div>
  {:else if active === "assign"}
    <div class="form-group"><label for="assign-profile">Profile (or “none” to unassign)</label>
      <input id="assign-profile" type="text" bind:value={profile} /></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !profile.trim()}>Assign</button>
    </div>
  {:else if active === "reassign"}
    <div class="form-group"><label for="reassign-profile">Profile (or “none”)</label>
      <input id="reassign-profile" type="text" bind:value={profile} /></div>
    <label class="check"><input type="checkbox" bind:checked={reclaim} /> Reclaim active claim first</label>
    <div class="form-group"><label for="reassign-reason">Reason (optional)</label>
      <textarea id="reassign-reason" bind:value={reason} rows="2"></textarea></div>
    {#if reclaim}
      <p class="stack-sm warn-text">Reclaiming releases the active claim on this running task.</p>
      <label class="check"><input type="checkbox" bind:checked={confirmChecked} /> Confirm</label>
    {/if}
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !profile.trim() || (reclaim && !confirmChecked)}>Reassign</button>
    </div>
  {:else if active === "claim"}
    <div class="form-group"><label for="claim-ttl">TTL seconds (optional)</label>
      <input id="claim-ttl" type="number" min="1" bind:value={ttl} /></div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy}>Claim</button>
    </div>
  {:else if active === "reclaim"}
    <p class="stack-sm warn-text">Reclaim releases the active claim on this running task and returns it to ready.</p>
    {#if flags.assignReassign}
      <div class="form-group"><label for="reclaim-reason">Reason (optional)</label>
        <textarea id="reclaim-reason" bind:value={reason} rows="2"></textarea></div>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={confirmChecked} /> Confirm</label>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || !confirmChecked}>Reclaim</button>
    </div>
  {:else if active === "heartbeat"}
    <div class="form-group">
      <label for="hb-note">Note (optional, max 4096 bytes)</label>
      <textarea id="hb-note" bind:value={note} rows="3" aria-describedby="hb-note-count"></textarea>
      <span id="hb-note-count" class="hint">{noteBytes}/4096 bytes{#if noteOver} — over the limit{/if}</span>
      {#if noteOver}<span class="error" role="alert">Note exceeds 4096 bytes.</span>{/if}
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button type="button" class="btn btn--primary" onclick={submit} disabled={busy || noteOver}>Heartbeat</button>
    </div>
  {/if}
</Dialog>

<style>
  .action-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .result-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
    font-size: 13px;
    background: var(--surface);
  }
  .result-row.success { background: var(--accent-muted); }
  .result-row.skipped { color: var(--text-dim); }
  .result-row.error { background: var(--warning); color: var(--warning-text); }
  .result-status {
    text-transform: uppercase;
    font-size: 11px;
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
  .hint { font-size: 12px; margin-bottom: 12px; }
  .busy { color: var(--text-dim); font-size: 13px; font-family: var(--font-ui); }
  .dialog-error {
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--warning);
    color: var(--warning-text);
    font-size: 13px;
  }
</style>
