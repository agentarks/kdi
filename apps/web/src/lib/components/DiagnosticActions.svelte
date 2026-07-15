<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import Dialog from "$lib/components/Dialog.svelte";
  import { postTaskAction } from "$lib/lifecycle";
  import type { LifecycleAction, LifecycleFields } from "$lib/types";

  interface Props {
    actions: string[];
    boardSlug: string;
    taskId: number;
  }

  type DiagnosticAction = "reclaim" | "reassign" | "unblock" | "comment" | "cli_hint" | "open_docs";
  const supported = new Set<string>(["reclaim", "reassign", "unblock", "comment", "cli_hint", "open_docs"]);
  const docsUrl = "https://github.com/agentarks/kdi/blob/main/specs/hermes-kanban-backlog.md";

  let { actions, boardSlug, taskId }: Props = $props();
  let dialog = $state<Dialog | undefined>(undefined);
  let active = $state<DiagnosticAction | null>(null);
  let reason = $state("");
  let profile = $state("");
  let text = $state("");
  let confirmed = $state(false);
  let busy = $state(false);
  let dialogError = $state<string | null>(null);
  let announcement = $state<{ message: string; error: boolean } | null>(null);

  function open(action: DiagnosticAction): void {
    announcement = null;
    if (action === "cli_hint") {
      copyCliHint();
      return;
    }
    if (action === "open_docs") {
      window.open(docsUrl, "_blank", "noopener,noreferrer");
      return;
    }
    active = action;
    reason = "";
    profile = "";
    text = "";
    confirmed = false;
    dialogError = null;
    dialog?.open();
  }

  async function copyCliHint(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`kdi diagnostics --board ${boardSlug} --task ${taskId}`);
      announcement = { message: "CLI command copied.", error: false };
    } catch {
      announcement = { message: "Could not copy CLI command.", error: true };
    }
  }

  async function submit(): Promise<void> {
    if (!active || busy) return;
    busy = true;
    dialogError = null;
    try {
      if (active === "comment") {
        const response = await fetch(`/api/boards/${boardSlug}/tasks/${taskId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json().catch(() => ({})) as { message?: string };
        if (!response.ok) {
          dialogError = body.message ?? `Request failed (${response.status})`;
          return;
        }
      } else {
        const fields: LifecycleFields = active === "reassign"
          ? { profile: profile.trim(), reclaim: true, reason: reason.trim() || undefined }
          : { reason: reason.trim() || undefined };
        const { ok, result } = await postTaskAction(boardSlug, taskId, active as LifecycleAction, fields);
        if (!ok || result.status !== "success") {
          dialogError = result.message;
          return;
        }
      }
      dialog?.close();
      try {
        await invalidateAll();
      } catch {
        announcement = { message: "Action succeeded, but the page could not be refreshed.", error: true };
      }
    } catch (error) {
      dialogError = error instanceof Error ? error.message : "Request failed.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="diagnostic-actions">
  {#each actions.filter((action) => supported.has(action)) as action}
    <button type="button" class="badge action-label" onclick={() => open(action as DiagnosticAction)}>{action}</button>
  {/each}
</div>

{#if announcement}
  <p class="sr-only" role={announcement.error ? "alert" : "status"} aria-live="polite">{announcement.message}</p>
{/if}

<Dialog bind:this={dialog} title={active ?? "Diagnostic action"}>
  {#if dialogError}
    <p class="dialog-error" role="alert">{dialogError}</p>
  {/if}

  {#if active === "reclaim"}
    <p class="hint">Reclaim task #{taskId} and return it to ready?</p>
    <label class="form-group">
      Reason (optional)
      <textarea bind:value={reason} rows="2"></textarea>
    </label>
    <label class="check"><input type="checkbox" bind:checked={confirmed} /> Confirm reclaim</label>
  {:else if active === "reassign"}
    <label class="form-group">
      Profile (required)
      <input type="text" bind:value={profile} />
    </label>
    <label class="form-group">
      Reason (optional)
      <textarea bind:value={reason} rows="2"></textarea>
    </label>
    <p class="hint">Any active claim will be reclaimed first.</p>
  {:else if active === "unblock"}
    <label class="form-group">
      Reason (optional)
      <textarea bind:value={reason} rows="2"></textarea>
    </label>
  {:else if active === "comment"}
    <label class="form-group">
      Comment (required)
      <textarea bind:value={text} rows="3"></textarea>
    </label>
  {/if}

  <div class="dialog-actions">
    <button type="button" class="btn" onclick={() => dialog?.close()} disabled={busy}>Cancel</button>
    <button
      type="button"
      class="btn btn--primary"
      onclick={submit}
      disabled={busy || (active === "reclaim" && !confirmed) || (active === "reassign" && !profile.trim()) || (active === "comment" && !text.trim())}
    >{active}</button>
  </div>
</Dialog>

<style>
  .diagnostic-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .action-label {
    background: var(--surface-2);
    color: var(--text-dim);
    cursor: pointer;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 13px;
  }
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
