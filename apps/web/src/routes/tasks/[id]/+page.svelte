<script lang="ts">
  import { enhance } from "$app/forms";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form?: ActionData } = $props();

  const currentProfile = $derived(data.task?.assignee ?? "user");

  function confirmSubmit(event: Event, message: string) {
    if (!confirm(message)) {
      event.preventDefault();
    }
  }
</script>

<svelte:head>
  <title>Task {data.task?.id ?? ""} — kdi</title>
</svelte:head>

{#if !data.enabled}
  <p class="text-dim">SvelteKit UI is disabled.</p>
{:else if !data.task}
  <p class="text-dim">Task not found.</p>
{:else}
  {@const task = data.task}
  <article class="task-detail">
    <header class="stack-md">
      <h1>#{task.id} {task.title}</h1>
      <p class="text-dim">
        status: {task.status}
        {#if data.board}· board: {data.board.slug}{/if}
        {#if task.assignee}· assignee: {task.assignee}{/if}
        · priority: {task.priority}
      </p>
    </header>

    {#if task.body}
      <section class="stack-md">
        <h2>Body</h2>
        <pre class="body-block">{task.body}</pre>
      </section>
    {/if}

    {#if task.block_reason}
      <section class="stack-md">
        <h2>Block reason</h2>
        <p class="text-dim">{task.block_reason}</p>
      </section>
    {/if}
    {#if task.schedule_reason}
      <section class="stack-md">
        <h2>Schedule reason</h2>
        <p class="text-dim">{task.schedule_reason}</p>
      </section>
    {/if}
    {#if task.review_reason}
      <section class="stack-md">
        <h2>Review reason</h2>
        <p class="text-dim">{task.review_reason}</p>
      </section>
    {/if}
    {#if task.result}
      <section class="stack-md">
        <h2>Result</h2>
        <p class="text-dim">{task.result}</p>
      </section>
    {/if}
    {#if task.summary}
      <section class="stack-md">
        <h2>Summary</h2>
        <p class="text-dim">{task.summary}</p>
      </section>
    {/if}
    {#if task.claim_lock}
      <section class="stack-md">
        <h2>Claim</h2>
        <p class="text-dim">
          lock: {task.claim_lock}
          {#if task.claim_expires}· expires at {new Date(task.claim_expires * 1000).toISOString()}{/if}
        </p>
      </section>
    {/if}

    {#if form?.result}
      <section class="result-panel stack-md">
        <h2>Action result</h2>
        <p class="text-dim">
          <span class="result-status">{form.result.status}</span>
          <span class="result-id">task {form.result.taskId}</span>
          <span class="result-message">{form.result.message}</span>
          {#if form.result.currentStatus}<span class="result-status">→ {form.result.currentStatus}</span>{/if}
        </p>
      </section>
    {/if}

    <section class="actions stack-md">
      <h2>Actions</h2>

      <form method="POST" use:enhance class="action-form">
        <input type="hidden" name="_action" value="promote" />
        <label><input type="checkbox" name="dryRun" /> Dry run</label>
        <label><input type="checkbox" name="force" /> Force</label>
        <button class="btn" type="submit">Promote</button>
      </form>

      <form method="POST" use:enhance class="action-form">
        <input type="hidden" name="_action" value="block" />
        <label>
          Reason (required)
          <textarea name="reason" rows="2" required></textarea>
        </label>
        <button class="btn" type="submit">Block</button>
      </form>

      <form method="POST" use:enhance class="action-form">
        <input type="hidden" name="_action" value="unblock" />
        <label>
          Reason (optional)
          <textarea name="reason" rows="2"></textarea>
        </label>
        <button class="btn" type="submit">Unblock</button>
      </form>

      {#if data.capabilities?.scheduled}
        <form method="POST" use:enhance class="action-form">
          <input type="hidden" name="_action" value="schedule" />
          <label>
            At
            <input type="datetime-local" name="at" required />
          </label>
          <label>
            Reason (optional)
            <textarea name="reason" rows="2"></textarea>
          </label>
          <button class="btn" type="submit">Schedule</button>
        </form>
      {/if}

      {#if data.capabilities?.review}
        <form method="POST" use:enhance class="action-form">
          <input type="hidden" name="_action" value="review" />
          <label>
            Reason (optional)
            <textarea name="reason" rows="2"></textarea>
          </label>
          <button class="btn" type="submit">Review</button>
        </form>
      {/if}

      <form method="POST" use:enhance class="action-form"
        onsubmit={(e) => confirmSubmit(e, `Archive task ${task.id}: ${task.title}?`)}>
        <input type="hidden" name="_action" value="archive" />
        <button class="btn" type="submit">Archive</button>
      </form>

      <form method="POST" use:enhance class="action-form"
        onsubmit={(e) => confirmSubmit(e, `Complete task ${task.id}: ${task.title}?`)}>
        <input type="hidden" name="_action" value="complete" />
        <label>
          Result
          <input type="text" name="result" />
        </label>
        <label>
          Summary
          <input type="text" name="summary" />
        </label>
        {#if data.capabilities?.completeMetadata}
          <label>
            Metadata (JSON)
            <textarea name="metadata" rows="2"></textarea>
          </label>
        {/if}
        <button class="btn btn--primary" type="submit">Complete</button>
      </form>

      {#if data.capabilities?.assignReassign}
        <form method="POST" use:enhance class="action-form">
          <input type="hidden" name="_action" value="assign" />
          <label>
            Profile
            <input type="text" name="profile" value={currentProfile} />
          </label>
          <button class="btn" type="submit">Assign</button>
        </form>

        <form method="POST" use:enhance class="action-form"
          onsubmit={(e) => confirmSubmit(e, `Reassign task ${task.id}?`)}>
          <input type="hidden" name="_action" value="reassign" />
          <label>
            Profile
            <input type="text" name="profile" />
          </label>
          <label><input type="checkbox" name="reclaim" /> Reclaim active claim</label>
          <label>
            Reason (optional)
            <textarea name="reason" rows="2"></textarea>
          </label>
          <button class="btn" type="submit">Reassign</button>
        </form>
      {/if}

      <form method="POST" use:enhance class="action-form">
        <input type="hidden" name="_action" value="claim" />
        <label>
          Profile
          <input type="text" name="profile" value={currentProfile} />
        </label>
        <label>
          TTL (seconds)
          <input type="number" name="ttl" min="1" />
        </label>
        <button class="btn btn--primary" type="submit">Claim</button>
      </form>

      <form method="POST" use:enhance class="action-form"
        onsubmit={(e) => confirmSubmit(e, `Reclaim task ${task.id}?`)}>
        <input type="hidden" name="_action" value="reclaim" />
        <label>
          Reason (optional)
          <textarea name="reason" rows="2"></textarea>
        </label>
        <button class="btn" type="submit">Reclaim</button>
      </form>

      {#if data.capabilities?.heartbeat}
        <form method="POST" use:enhance class="action-form">
          <input type="hidden" name="_action" value="heartbeat" />
          <label>
            Note (optional, max 4 KiB)
            <textarea name="note" rows="2"></textarea>
          </label>
          <button class="btn" type="submit">Heartbeat</button>
        </form>
      {/if}
    </section>
  </article>
{/if}

<style>
  .task-detail {
    max-width: 720px;
  }
  .task-detail h1 {
    margin: 0;
  }
  .task-detail h2 {
    font-size: 14px;
    color: var(--text-dim);
    margin: 0 0 8px;
  }
  .body-block {
    white-space: pre-wrap;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin: 0;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .action-form {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .action-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .action-form input,
  .action-form textarea {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    color: var(--text);
  }
  .action-form button {
    margin-left: auto;
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
  .result-status {
    font-family: var(--mono);
    color: var(--text-dim);
  }
  .result-id {
    font-family: var(--mono);
    margin-left: 8px;
  }
  .result-message {
    margin-left: 8px;
  }
</style>
