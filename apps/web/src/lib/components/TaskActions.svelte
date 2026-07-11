<script lang="ts">
  import Dialog from "$lib/components/Dialog.svelte";
  import { invalidateAll } from "$app/navigation";
  import type { TaskDetailTask, LifecycleFlags, LifecycleAction, LifecycleResult, LifecycleFields } from "$lib/types";

  interface Props {
    task: TaskDetailTask;
    flags: LifecycleFlags;
    boardSlug: string;
    currentProfile: string;
  }
  let { task, flags, boardSlug, currentProfile }: Props = $props();

  let dialog = $state<Dialog | undefined>(undefined);

  interface ActionButton {
    action: LifecycleAction;
    label: string;
    needsConfirm?: boolean;
  }

  const SINGLE_BUTTONS: ActionButton[] = [
    { action: "promote", label: "Promote" },
    { action: "block", label: "Block" },
    { action: "unblock", label: "Unblock" },
    { action: "schedule", label: "Schedule" },
    { action: "review", label: "Review" },
    { action: "claim", label: "Claim" },
    { action: "reclaim", label: "Reclaim", needsConfirm: true },
    { action: "assign", label: "Assign" },
    { action: "reassign", label: "Reassign" },
    { action: "heartbeat", label: "Heartbeat" },
    { action: "complete", label: "Complete", needsConfirm: true },
    { action: "archive", label: "Archive", needsConfirm: true },
  ];
  let active = $state<LifecycleAction | null>(null);
  let busy = $state(false);
  let result = $state<LifecycleResult | null>(null);

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
  let dryRun = $state(false);
  let confirmChecked = $state(false);
  let dryRunResult = $state<LifecycleResult | null>(null);

  const archived = $derived(task.archivedAt !== null);
  // Per-action enable conditions (FR-27). Client gating is UX only; the server
  // re-checks. Disabled controls get a flag/status tooltip.
  const can = $derived<Record<LifecycleAction, boolean>>({
    promote: task.status === "todo" && !archived,
    block: task.status !== "blocked" && !archived,
    unblock: (task.status === "blocked" || task.status === "scheduled") && !archived,
    schedule: flags.scheduledStatus && !archived,
    review: flags.reviewStatus && task.status !== "review" && !archived,
    archive: !archived,
    complete: !archived,
    assign: flags.assignReassign && !archived,
    reassign: flags.assignReassign && !archived,
    claim: task.status === "ready" && !archived,
    reclaim: task.status === "running" && task.claimLock !== null && !archived,
    heartbeat: flags.heartbeat && task.status === "running" && !archived,
  });

  function tooltip(action: LifecycleAction): string | undefined {
    if (can[action]) return undefined;
    if (archived) return "Task is archived";
    switch (action) {
      case "promote": return task.status === "todo" ? undefined : `Only todo tasks (current: ${task.status})`;
      case "block": return task.status === "blocked" ? "Already blocked" : undefined;
      case "unblock": return "Only blocked or scheduled tasks";
      case "schedule": return !flags.scheduledStatus ? "FF_SCHEDULED_STATUS" : undefined;
      case "review": return !flags.reviewStatus ? "FF_REVIEW_STATUS" : (task.status === "review" ? "Already in review" : undefined);
      case "assign":
      case "reassign": return !flags.assignReassign ? "FF_ASSIGN_REASSIGN" : undefined;
      case "claim": return task.status !== "ready" ? `Only ready tasks (current: ${task.status})` : undefined;
      case "reclaim": return task.status !== "running" ? `Only running tasks (current: ${task.status})` : (task.claimLock === null ? "No active claim" : undefined);
      case "heartbeat": return !flags.heartbeat ? "FF_HEARTBEAT" : (task.status !== "running" ? "Only running tasks" : undefined);
      default: return undefined;
    }
  }

  function resetFields() {
    reason = ""; atLocal = ""; profile = ""; reclaim = false; ttl = "";
    note = ""; resultText = ""; summary = ""; metadata = "";
    force = false; dryRun = false; confirmChecked = false; dryRunResult = null;
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
    const res = await fetch(`/api/boards/${boardSlug}/tasks/${task.id}/${active}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, result: data.result as LifecycleResult };
    return { ok: false, result: { taskId: task.id, status: "error", message: data.message ?? `Request failed (${res.status})` } };
  }

  async function submit() {
    if (!active || busy) return;
    busy = true;
    try {
      const { ok, result: r } = await post(fieldsFor(active, false));
      result = r;
      if (ok && r.status !== "skipped") await invalidateAll();
      if (ok) dialog?.close();
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

  const noteOver = $derived(note.length > 4096);

  // FR-9: the UI rejects times in the past before calling the model.
  const atInPast = $derived(atLocal !== "" && toUnix(atLocal) <= Math.floor(Date.now() / 1000));
</script>

<section class="detail-section" aria-labelledby="actions-heading">
  <h2 id="actions-heading">Actions</h2>

  {#if result}
    <p class="result-row {result.status}">
      <strong>#{result.taskId}</strong>
      <span class="result-status">{result.status}</span>
      <span>{result.message}</span>
    </p>
  {/if}

  <div class="action-grid">
    {#each SINGLE_BUTTONS as btn (btn.action)}
      <button
        type="button"
        class="btn"
        disabled={!can[btn.action]}
        title={tooltip(btn.action)}
        onclick={() => open(btn.action)}
      >
        {btn.label}
      </button>
    {/each}
  </div>
</section>

<Dialog bind:this={dialog} title={active ? SINGLE_BUTTONS.find((b) => b.action === active)?.label ?? active : ""}>
  {#if active === "promote"}
    <label class="check"><input type="checkbox" bind:checked={dryRun} disabled={!flags.bulkOperations} title={flags.bulkOperations ? undefined : "FF_BULK_OPERATIONS"} /> Dry run (preview verdict)</label>
    <label class="check"><input type="checkbox" bind:checked={force} disabled={!flags.bulkOperations} title={flags.bulkOperations ? undefined : "FF_BULK_OPERATIONS"} /> Force (bypass parent dependencies)</label>
    {#if dryRunResult}
      <p class="result-row {dryRunResult.status}">Dry run: {dryRunResult.message}</p>
    {/if}
    <div class="dialog-actions">
      <button type="button" class="btn" onclick={runDryRun} disabled={busy}>Dry run</button>
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
    <p class="stack-sm warn-text">Archive <strong>#{task.id} {task.title}</strong>? This is one-way — no UI restore exists.</p>
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
      <textarea id="hb-note" bind:value={note} rows="3" maxlength="4096"></textarea>
      {#if noteOver}<span class="error">Note exceeds 4096 bytes.</span>{/if}
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
</style>
