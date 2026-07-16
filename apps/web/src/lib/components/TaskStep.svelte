<script lang="ts">
  // KDI-UI-013 Slice 3: workflow step action cluster for the task detail panel.
  // Renders advance (Next step) + jump (Jump to step) controls with an optional
  // reason, mirrored on the CLI `kdi step` command. Sits below the KDI-UI-006
  // lifecycle actions as a separate, always-visible (when workflow-bound) cluster
  // so the two never collide (slice-plan Gap 4). All gating is UX-only; the
  // server re-checks `FF_WORKFLOW_TEMPLATES` (FR-24/FR-27).
  import { invalidateAll } from "$app/navigation";
  import type { TaskDetailTask, DetailFlags } from "$lib/types";

  interface Props {
    task: TaskDetailTask;
    steps: string[] | null;
    flags: DetailFlags;
    boardSlug: string;
  }
  let { task, steps, flags, boardSlug }: Props = $props();

  const visible = $derived(
    !!task.workflowTemplateId && flags.workflowTemplates && task.archivedAt === null,
  );
  // FR-25: disabled (not hidden) when done so the operator sees the terminal state.
  const disabled = $derived(task.status === "done" || task.archivedAt !== null);

  let reason = $state("");
  let jumpKey = $state("");
  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  const encoder = new TextEncoder();
  const reasonBytes = $derived(encoder.encode(reason).length);
  const reasonOver = $derived(reasonBytes > 4096);
  // Default the jump select to the current step (or the first step) so it always
  // has a valid value when the cluster opens.
  $effect(() => {
    if (steps && steps.length > 0) {
      jumpKey = task.currentStepKey ?? steps[0];
    }
  });

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const res = await fetch(`/api/boards/${boardSlug}/tasks/${task.id}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.ok) return { ok: true, message: data.message ?? "Step updated." };
    return { ok: false, message: data.message ?? `Request failed (${res.status})` };
  }

  async function advance() {
    if (busy || disabled) return;
    busy = true;
    error = null;
    try {
      const { ok, message: msg } = await post({ action: "advance", reason: reason || undefined });
      if (!ok) {
        error = msg;
        return;
      }
      message = msg;
      reason = "";
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function jump() {
    if (busy || disabled) return;
    if (!jumpKey.trim()) {
      error = "Step key cannot be empty.";
      return;
    }
    busy = true;
    error = null;
    try {
      const { ok, message: msg } = await post({ action: "jump", targetKey: jumpKey, reason: reason || undefined });
      if (!ok) {
        error = msg;
        return;
      }
      message = msg;
      reason = "";
      await invalidateAll();
    } finally {
      busy = false;
    }
  }
</script>

{#if visible}
  <section class="detail-section step-section" aria-labelledby="step-heading">
    <h2 id="step-heading">Workflow step</h2>
    {#if message}
      <p class="result-row success" role="status" aria-live="polite">{message}</p>
    {/if}
    {#if error}
      <p class="step-error" role="alert">{error}</p>
    {/if}
    {#if busy}
      <p class="busy" role="status" aria-live="polite">Working…</p>
    {/if}

    <div class="step-controls">
      <button
        type="button"
        class="btn btn--primary"
        aria-disabled={disabled}
        aria-describedby={disabled ? "step-disabled-reason" : undefined}
        onclick={advance}
      >
        Next step
      </button>

      {#if steps && steps.length > 1}
        <label class="jump-group">
          <span class="jump-label">Jump to step</span>
          <select bind:value={jumpKey} aria-disabled={disabled}>
            {#each steps as key (key)}
              <option value={key}>{key}</option>
            {/each}
          </select>
          <button
            type="button"
            class="btn"
            aria-disabled={disabled}
            aria-describedby={disabled ? "step-disabled-reason" : undefined}
            onclick={jump}
          >
            Jump
          </button>
        </label>
      {/if}
    </div>

    <div class="form-group">
      <label for="step-reason">Reason (optional, max 4096 bytes)</label>
      <textarea id="step-reason" bind:value={reason} rows="2" aria-describedby="step-reason-count"></textarea>
      <span id="step-reason-count" class="hint">{reasonBytes}/4096 bytes{#if reasonOver} — over the limit{/if}</span>
      {#if reasonOver}<span class="error" role="alert">Reason exceeds 4096 bytes.</span>{/if}
    </div>

    {#if disabled}
      <span id="step-disabled-reason" class="sr-only">Task is {task.status === "done" ? "done" : "archived"}; step actions are not available.</span>
    {/if}
  </section>
{/if}

<style>
  .step-section { display: flex; flex-direction: column; gap: 10px; }
  .step-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .jump-group { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .jump-label { font-weight: 600; font-family: var(--font-ui); }
  .jump-group select {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 6px;
    background: var(--surface);
    font-family: var(--font-ui);
  }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .form-group textarea { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px; font-family: var(--font-ui); resize: vertical; }
  .result-row {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--accent-muted);
    font-size: 13px;
  }
  .step-error {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--warning);
    color: var(--warning-text);
    font-size: 13px;
  }
  .busy { color: var(--text-dim); font-size: 13px; font-family: var(--font-ui); }
  .hint { font-size: 12px; color: var(--text-dim); }
  .error { font-size: 12px; color: var(--warning-text); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
</style>