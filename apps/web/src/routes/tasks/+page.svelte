<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form?: ActionData } = $props();

  const bulkActions = [
    { key: "promote", label: "Promote", needs: null },
    { key: "block", label: "Block", needs: null },
    { key: "unblock", label: "Unblock", needs: null },
    { key: "schedule", label: "Schedule", needs: "schedule" as const },
    { key: "archive", label: "Archive", needs: null },
    { key: "complete", label: "Complete", needs: null },
  ];

  const selected = $state<Set<number>>(new Set());

  function toggle(id: number, checked: boolean) {
    if (checked) selected.add(id);
    else selected.delete(id);
  }

  function toggleAll(checked: boolean) {
    if (checked) {
      for (const t of data.tasks ?? []) selected.add(t.id);
    } else {
      selected.clear();
    }
  }

  function rowHref(id: number): string {
    const params = new URLSearchParams(page.url.search);
    return `/tasks/${id}?${params.toString()}`;
  }

  function bulkSubmit(event: Event, action: string) {
    if (action === "archive" && !confirm("Archive selected tasks?")) {
      event.preventDefault();
      return;
    }
    const button = event.currentTarget as HTMLButtonElement;
    const formEl = button.form;
    if (!formEl) return;
    const hidden = formEl.querySelector("input[name=_action]") as HTMLInputElement | null;
    if (hidden) hidden.value = action;
  }

  const bulkReason = $state({
    reason: "",
    at: "",
    result: "",
  });
</script>

<svelte:head>
  <title>Tasks — kdi</title>
</svelte:head>

<h1 class="stack-md">Tasks</h1>

{#if !data.enabled}
  <p class="text-dim">SvelteKit UI is disabled.</p>
{:else}
  {#if data.board}
    <p class="stack-sm text-dim">Board: {data.boardSlug}</p>
  {:else}
    <p class="stack-sm text-dim">Board: {data.boardSlug} (not found)</p>
  {/if}

  {#if !data.capabilities?.bulk}
    <p class="stack-sm text-dim">Bulk operations are disabled (FF_BULK_OPERATIONS=false).</p>
  {/if}

  <form method="POST" use:enhance class="bulk-bar stack-md">
    <input type="hidden" name="_action" value="" />
    <div class="bulk-fields">
      <label>
        Reason
        <input type="text" name="reason" bind:value={bulkReason.reason} placeholder="block / unblock / schedule" />
      </label>
      {#if data.capabilities?.schedule}
        <label>
          At
          <input type="datetime-local" name="at" bind:value={bulkReason.at} />
        </label>
      {/if}
      <label>
        Result
        <input type="text" name="result" bind:value={bulkReason.result} placeholder="complete" />
      </label>
    </div>
    <div class="bulk-buttons">
      {#each bulkActions as { key, label, needs }}
        {@const disabled =
          !data.capabilities?.bulk ||
          (needs !== null && !data.capabilities[needs])}
        {@const flagName = needs ?? "FF_BULK_OPERATIONS"}
        <button
          class="btn"
          type="submit"
          disabled={disabled}
          title={disabled ? `${flagName} is off` : label}
          onclick={(e) => bulkSubmit(e, key)}
        >
          {label}
        </button>
      {/each}
    </div>
  </form>

  {#if form?.action}
    <section class="result-panel stack-md">
      <h2>Bulk {form.action} result</h2>
      <p class="text-dim">
        attempted {form.summary.attempted}, succeeded {form.summary.succeeded},
        skipped {form.summary.skipped}, failed {form.summary.failed}
      </p>
      {#if form.results}
        <ul class="result-list">
          {#each form.results as r}
            <li class="result-row" class:success={r.status === "success"} class:skipped={r.status === "skipped"} class:error={r.status === "error"}>
              <span class="result-status">{r.status}</span>
              <span class="result-id">task {r.taskId}</span>
              <span class="result-message">{r.message}</span>
              {#if r.currentStatus}<span class="result-status">→ {r.currentStatus}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <table class="task-table">
    <thead>
      <tr>
        <th><input type="checkbox" onchange={(e) => toggleAll(e.currentTarget.checked)} aria-label="Select all" /></th>
        <th>ID</th>
        <th>Title</th>
        <th>Status</th>
        <th>Assignee</th>
        <th>Priority</th>
      </tr>
    </thead>
    <tbody>
      {#each data.tasks ?? [] as task (task.id)}
        <tr class="task-row">
          <td><input type="checkbox" name="selected" value={task.id} checked={selected.has(task.id)} onchange={(e) => toggle(task.id, e.currentTarget.checked)} /></td>
          <td><a href={rowHref(task.id)}>{task.id}</a></td>
          <td><a href={rowHref(task.id)}>{task.title}</a></td>
          <td>{task.status}</td>
          <td>{task.assignee ?? "—"}</td>
          <td>{task.priority}</td>
        </tr>
      {:else}
        <tr>
          <td colspan="6" class="text-dim">No tasks found.</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .bulk-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .bulk-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    flex: 1;
  }
  .bulk-fields label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .bulk-fields input {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    color: var(--text);
  }
  .bulk-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .task-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .task-table th,
  .task-table td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .task-table th {
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
  }
  .task-row:hover {
    background: var(--panel-2);
  }
  .result-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .result-panel h2 {
    font-size: 14px;
    margin: 0 0 8px;
  }
  .result-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .result-row {
    display: flex;
    gap: 12px;
    padding: 6px 0;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .result-row:last-child {
    border-bottom: none;
  }
  .result-status {
    font-family: var(--mono);
    color: var(--text-dim);
  }
  .result-row.success .result-status:first-child {
    color: var(--ok);
  }
  .result-row.error .result-status:first-child {
    color: #ff6b6b;
  }
  .result-row.skipped .result-status:first-child {
    color: #f0c674;
  }
  .result-id {
    font-family: var(--mono);
    min-width: 80px;
  }
  .result-message {
    flex: 1;
  }
</style>
