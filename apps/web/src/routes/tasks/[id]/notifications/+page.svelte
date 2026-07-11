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
  const subscribed = $derived((form as { subscribed?: boolean } | null)?.subscribed === true);
  const platforms = ["telegram", "slack", "discord", "webhook"] as const;

  let values = $state({
    platform: "telegram",
    chat_id: "",
    thread_id: "",
    user_id: "",
    notifier_profile: "",
  });

  $effect(() => {
    const f = form as ({ values?: Record<string, string>; subscribed?: boolean } | null);
    if (f?.subscribed) {
      values = { platform: "telegram", chat_id: "", thread_id: "", user_id: "", notifier_profile: "" };
    } else if (f?.values) {
      values = { ...f.values } as typeof values;
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

    <section class="stack-sm">
      <h2>Subscribe</h2>
      {#if form?.error}
        <p class="error" role="alert">{form.error}</p>
      {:else if subscribed}
        <p class="success" role="status">Subscribed.</p>
      {/if}
      <form method="POST" action="?/subscribe" use:enhance class="subscribe-form">
        <div class="form-group">
          <label for="platform">Platform</label>
          <select id="platform" name="platform" bind:value={values.platform}>
            {#each platforms as p}<option value={p}>{p}</option>{/each}
          </select>
        </div>
        <div class="form-group">
          <label for="chat_id">Chat ID <span class="req">*</span></label>
          <input id="chat_id" name="chat_id" type="text" required bind:value={values.chat_id} />
        </div>
        <div class="form-group">
          <label for="thread_id">Thread ID</label>
          <input id="thread_id" name="thread_id" type="text" bind:value={values.thread_id} />
        </div>
        <div class="form-group">
          <label for="user_id">User ID</label>
          <input id="user_id" name="user_id" type="text" bind:value={values.user_id} />
        </div>
        <div class="form-group">
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
        <table class="table">
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
              <tr class:archived={sub.unsubscribedAt !== null}>
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
  /* DESIGN.md CSS architecture: forms/tables use the global .form-group / .table
     classes; only component-specific LAYOUT (the subscribe grid) lives here and
     consumes the global tokens. Archived rows dim to opacity 0.6 (DESIGN.md a11y). */
  .subscribe-form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    align-items: end;
  }
  /* Let the grid gap, not .form-group's bottom margin, control row spacing. */
  .subscribe-form .form-group {
    margin-bottom: 0;
  }
  .req {
    color: var(--warning);
  }
  .table tr.archived {
    opacity: 0.6;
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
</style>
