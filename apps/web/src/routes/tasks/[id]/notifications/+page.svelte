<script lang="ts">
  // KDI-UI-010: per-task subscriptions + subscribe form.
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import type { PageData, ActionData } from "./$types";
  import { formatAge } from "$lib/kanban";

  interface Subscription {
    id: number;
    taskId: number;
    platform: string;
    chatId: string;
    threadId: string | null;
    userId: string | null;
    notifierProfile: string;
    subscribedAt: number;
    unsubscribedAt: number | null;
  }

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const task = $derived(data.task);
  const subscriptions = $derived((data.subscriptions ?? []) as Subscription[]);
  const includeArchived = $derived(data.includeArchived === true);
  const platforms = ["telegram", "slack", "discord", "webhook"] as const;

  let values = $state({
    platform: "telegram",
    chat_id: "",
    thread_id: "",
    user_id: "",
    notifier_profile: "",
  });

  $effect(() => {
    const f = form as ({ values?: Record<string, string> } | null);
    if (f?.values) {
      values = { ...values, ...f.values };
    }
  });

  function toggleArchived(next: boolean) {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("archived", "1");
    else url.searchParams.delete("archived");
    goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head>
  <title>Subscriptions — task #{data.taskId} — kdi</title>
</svelte:head>

{#if !data.enabled}
  <div class="stack-md">
    <h1>Notification subscriptions</h1>
    <p class="text-dim">Notification subscriptions feature is not enabled.</p>
    <p class="text-dim">Enable it with <code>FF_NOTIFY_SUBS=true</code>.</p>
  </div>
{:else if task}
  <div class="stack-md">
    <div class="stack-sm">
      <a href="/boards/{data.boardSlug}">← Back to board</a>
      <h1>#{task.id} {task.title}</h1>
      <p class="text-dim">
        Status: <span class="badge">{task.status}</span>
        · <a href="/tasks/{task.id}?board={data.boardSlug}">Task detail →</a>
      </p>
    </div>

    <section class="panel stack-sm">
      <h2>Subscribe</h2>
      {#if form?.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}
      <form method="POST" action="?/subscribe" use:enhance class="stack-sm subscribe-form">
        <div class="field">
          <label for="platform">Platform</label>
          <select id="platform" name="platform" bind:value={values.platform}>
            {#each platforms as p}<option value={p}>{p}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label for="chat_id">Chat ID <span class="req">*</span></label>
          <input id="chat_id" name="chat_id" type="text" required bind:value={values.chat_id} />
        </div>
        <div class="field">
          <label for="thread_id">Thread ID</label>
          <input id="thread_id" name="thread_id" type="text" bind:value={values.thread_id} />
        </div>
        <div class="field">
          <label for="user_id">User ID</label>
          <input id="user_id" name="user_id" type="text" bind:value={values.user_id} />
        </div>
        <div class="field">
          <label for="notifier_profile">Notifier profile</label>
          <input id="notifier_profile" name="notifier_profile" type="text" placeholder="defaults to platform" bind:value={values.notifier_profile} />
        </div>
        <button type="submit" class="btn btn--primary">Subscribe</button>
      </form>
    </section>

    <section class="stack-sm">
      <div class="flex-between">
        <h2>Subscriptions</h2>
        <label class="inline">
          <input
            type="checkbox"
            checked={includeArchived}
            onchange={(e) => toggleArchived((e.currentTarget as HTMLInputElement).checked)}
          />
          Include unsubscribed
        </label>
      </div>

      {#if subscriptions.length === 0}
        <div class="placeholder">No subscriptions for this task yet.</div>
      {:else}
        <table class="subs-table">
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Platform</th>
              <th scope="col">Chat ID</th>
              <th scope="col">Thread</th>
              <th scope="col">User</th>
              <th scope="col">Profile</th>
              <th scope="col">Subscribed</th>
              {#if includeArchived}<th scope="col">Unsubscribed</th>{/if}
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each subscriptions as sub (sub.id)}
              <tr class:unsubscribed={sub.unsubscribedAt !== null}>
                <td>{sub.id}</td>
                <td><span class="badge">{sub.platform}</span></td>
                <td class="mono">{sub.chatId}</td>
                <td class="mono">{sub.threadId ?? "—"}</td>
                <td class="mono">{sub.userId ?? "—"}</td>
                <td>{sub.notifierProfile}</td>
                <td class="text-dim">{formatAge(sub.subscribedAt)}</td>
                {#if includeArchived}
                  <td class="text-dim">{sub.unsubscribedAt !== null ? formatAge(sub.unsubscribedAt) : "—"}</td>
                {/if}
                <td>
                  {#if sub.unsubscribedAt === null}
                    <form method="POST" action="?/unsubscribe" use:enhance class="inline-form">
                      <input type="hidden" name="platform" value={sub.platform} />
                      <input type="hidden" name="chat_id" value={sub.chatId} />
                      {#if sub.threadId}<input type="hidden" name="thread_id" value={sub.threadId} />{/if}
                      <button type="submit" class="btn">Unsubscribe</button>
                    </form>
                  {:else}
                    <span class="badge">unsubscribed</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  </div>
{:else}
  <div class="stack-md">
    <h1>Task not found</h1>
    <p class="text-dim">Task {data.taskId} was not found on board "{data.boardSlug}".</p>
    <p><a href="/boards/{data.boardSlug}">← Back to board</a></p>
  </div>
{/if}

<style>
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 16px;
  }
  .subscribe-form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    align-items: end;
  }
  .field label {
    display: block;
    margin-bottom: 4px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .field input,
  .field select {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text);
  }
  .req {
    color: var(--accent, #c00);
  }
  .subs-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .subs-table th,
  .subs-table td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .subs-table th {
    color: var(--text-dim);
    font-weight: 600;
  }
  .subs-table tr:last-child td {
    border-bottom: none;
  }
  .subs-table tr.unsubscribed {
    opacity: 0.55;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .inline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .inline-form {
    display: inline;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
