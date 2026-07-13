<script lang="ts">
  // KDI-UI-010: board-scoped notification subscriptions (read-only + unsubscribe).
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

  const board = $derived(data.board);
  const subscriptions = $derived((data.subscriptions ?? []) as Subscription[]);
  const includeArchived = $derived(data.includeArchived === true);

  function toggleArchived(next: boolean) {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("archived", "1");
    else url.searchParams.delete("archived");
    goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head>
  <title>Notification subscriptions — kdi</title>
</svelte:head>

{#if !data.enabled}
  <div class="stack-md">
    <h1>Notification subscriptions</h1>
    <p class="text-dim">Notification subscriptions feature is not enabled.</p>
    <p class="text-dim">Enable it with <code>FF_NOTIFY_SUBS=true</code>.</p>
  </div>
{:else if data.error}
  <div class="stack-md">
    <h1>Notification subscriptions</h1>
    <p class="error">{data.error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else}
  <div class="stack-md">
    <div class="flex-between">
      <div>
        <h1>Notification subscriptions</h1>
        <p class="text-dim">Board: <code>{data.boardSlug}</code></p>
      </div>
      <label class="inline">
        <input
          type="checkbox"
          checked={includeArchived}
          onchange={(e) => toggleArchived((e.currentTarget as HTMLInputElement).checked)}
        />
        Include unsubscribed
      </label>
    </div>

    {#if form?.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}

    {#if subscriptions.length === 0}
      <div class="placeholder">
        No active subscriptions.
        {#if board}
          <a href="/boards/{board.slug}">View board tasks →</a>
        {/if}
      </div>
    {:else}
      <table class="table">
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Task</th>
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
              <td><a href="/tasks/{sub.taskId}/notifications?board={data.boardSlug}">#{sub.taskId}</a></td>
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
                    <input type="hidden" name="board" value={data.boardSlug} />
                    <input type="hidden" name="task_id" value={sub.taskId} />
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
  </div>
{/if}

<style>
  /* WCAG AA archived treatment: do NOT dim the row via opacity. Parent opacity
     composites the whole subtree (including the badge) into one group, dropping
     badge fg/bg contrast to 4.18:1 — and a child opacity:1 cannot un-composite
     an ancestor group. Instead dim only the row's text; the badge stays at full
     strength (~13:1) and the row is still visibly archived via muted text + the
     "unsubscribed" tag. */
  .table tr.archived td,
  .table tr.archived .text-dim {
    color: var(--text-dim);
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
