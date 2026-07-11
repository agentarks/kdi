<script lang="ts">
  import type { PageProps } from "./$types";
  import { browser } from "$app/environment";
  import { onMount } from "svelte";
  import type { ActivityFlags, TaskEvent, TaskLog } from "$lib/types";
  import type { KanbanTask } from "$lib/kanban";
  import { formatAge, statusLabel } from "$lib/kanban";

  let { data }: PageProps = $props();

  const board = $derived(data.board);
  const flags = $derived(data.flags as ActivityFlags);
  const error = $derived(data.error);

  const params = browser ? new URLSearchParams(window.location.search) : new URLSearchParams();
  let live = $state(true);
  let pollInterval = $state(Math.max(Number(params.get("interval")) || 2, 0.5));
  let assignee = $state(params.get("assignee") ?? "");
  let tenant = $state(params.get("tenant") ?? "");
  let kinds = $state(params.get("kinds") ?? "");
  let selectedTaskId = $state<number | null>(params.get("task") ? Number(params.get("task")) : null);
  let selectedTask = $state<KanbanTask | null>(null);
  let taskLoading = $state(false);
  let events = $state<TaskEvent[]>([]);
  let taskEvents = $state<TaskEvent[]>([]);
  let taskLog = $state<TaskLog | null>(null);
  let taskEventsFollow = $state(true);
  let taskLogFollow = $state(true);
  let tailBytes = $state(Math.max(Number(params.get("tailBytes")) || 4096, 0));
  let hidden = $state(false);
  let streamError = $state<string | null>(null);
  let taskError = $state<string | null>(null);
  let taskEventsError = $state<string | null>(null);
  let logError = $state<string | null>(null);
  // Generation guards (P1-4): a stale fetch must never overwrite state for a
  // newer filter set or a different selected task. boardGen bumps on filter
  // apply; task panes guard on selectedTaskId captured at call time.
  let boardGen = 0;
  let boardTimer = $state<ReturnType<typeof setTimeout> | null>(null);
  let taskEventsTimer = $state<ReturnType<typeof setTimeout> | null>(null);
  let taskLogTimer = $state<ReturnType<typeof setTimeout> | null>(null);

  function payloadPreview(payload: string | null): string {
    if (!payload) return "";
    try {
      const obj = JSON.parse(payload);
      const text = JSON.stringify(obj);
      return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    } catch {
      return payload.length > 120 ? `${payload.slice(0, 120)}…` : payload;
    }
  }

  function mergeEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
    const seen = new Set(current.map((e) => e.id));
    const merged = [...current];
    for (const e of incoming) {
      if (!seen.has(e.id)) merged.push(e);
    }
    merged.sort((a, b) => b.id - a.id);
    if (merged.length > 200) merged.length = 200;
    return merged;
  }

  async function fetchBoardEvents() {
    if (!board || !browser) return;
    const gen = boardGen;
    const query = new URLSearchParams();
    const lastId = events.length > 0 ? events[0].id : undefined;
    if (lastId !== undefined) query.set("since", String(lastId));
    if (flags.watchFilters) {
      if (assignee) query.set("assignee", assignee);
      if (tenant && flags.tenantNamespace) query.set("tenant", tenant);
      if (kinds) query.set("kinds", kinds);
    }
    query.set("limit", "50");
    try {
      const r = await fetch(`/api/boards/${board.slug}/events?${query.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { events: TaskEvent[] };
      // Drop the result if filters changed while this request was in flight.
      if (gen !== boardGen) return;
      events = mergeEvents(events, j.events);
      streamError = null;
    } catch (e) {
      if (gen !== boardGen) return;
      streamError = e instanceof Error ? e.message : String(e);
    }
  }

  function scheduleBoardPoll() {
    if (boardTimer) clearTimeout(boardTimer);
    if (!browser || !board || !live || hidden) return;
    const intervalMs = Math.max(Number.isFinite(pollInterval) ? pollInterval : 0.5, 0.5) * 1000;
    boardTimer = setTimeout(async () => {
      await fetchBoardEvents();
      scheduleBoardPoll();
    }, intervalMs);
  }

  function stopBoardPoll() {
    if (boardTimer) {
      clearTimeout(boardTimer);
      boardTimer = null;
    }
  }

  async function fetchSelectedTask() {
    if (!board || selectedTaskId === null || !browser) return;
    const id = selectedTaskId;
    try {
      const r = await fetch(`/api/boards/${board.slug}/tasks/${selectedTaskId}`);
      // Drop the result if the user selected a different task while in flight.
      if (id !== selectedTaskId) return;
      if (r.status === 404) {
        selectedTask = null;
        taskError = null;
        return;
      }
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { task: KanbanTask };
      if (id !== selectedTaskId) return;
      selectedTask = j.task;
      taskError = null;
    } catch (e) {
      if (id !== selectedTaskId) return;
      taskError = e instanceof Error ? e.message : String(e);
    } finally {
      if (id === selectedTaskId) taskLoading = false;
    }
  }

  async function fetchTaskEvents() {
    if (!board || selectedTaskId === null || !browser) return;
    const id = selectedTaskId;
    const query = new URLSearchParams();
    const lastId = taskEvents.length > 0 ? taskEvents[0].id : undefined;
    if (taskEventsFollow && lastId !== undefined) query.set("since", String(lastId));
    try {
      const r = await fetch(`/api/boards/${board.slug}/tasks/${selectedTaskId}/events?${query.toString()}`);
      if (id !== selectedTaskId) return;
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { events: TaskEvent[] };
      if (id !== selectedTaskId) return;
      taskEvents = mergeEvents(taskEvents, j.events);
      taskEventsError = null;
    } catch (e) {
      if (id !== selectedTaskId) return;
      taskEventsError = e instanceof Error ? e.message : String(e);
    }
  }

  function scheduleTaskEventsPoll() {
    if (taskEventsTimer) clearTimeout(taskEventsTimer);
    if (!browser || !board || selectedTaskId === null || !taskEventsFollow || hidden) return;
    taskEventsTimer = setTimeout(async () => {
      await fetchTaskEvents();
      scheduleTaskEventsPoll();
    }, 2000);
  }

  function stopTaskEventsPoll() {
    if (taskEventsTimer) {
      clearTimeout(taskEventsTimer);
      taskEventsTimer = null;
    }
  }

  async function fetchTaskLog() {
    if (!board || selectedTaskId === null || !browser) return;
    const id = selectedTaskId;
    const query = new URLSearchParams();
    if (tailBytes) query.set("tail", String(tailBytes));
    try {
      const r = await fetch(`/api/boards/${board.slug}/tasks/${selectedTaskId}/log?${query.toString()}`);
      if (id !== selectedTaskId) return;
      // present:false is a valid "no log captured" answer (FR-12), not an error.
      // Distinguish a missing log from a server/network failure so a 5xx is not
      // masked as "No log captured yet."
      if (!r.ok) throw new Error(await r.text());
      taskLog = (await r.json()) as TaskLog;
      logError = null;
    } catch (e) {
      if (id !== selectedTaskId) return;
      logError = e instanceof Error ? e.message : String(e);
    }
  }

  function scheduleTaskLogPoll() {
    if (taskLogTimer) clearTimeout(taskLogTimer);
    if (!browser || !board || selectedTaskId === null || !taskLogFollow || hidden) return;
    taskLogTimer = setTimeout(async () => {
      await fetchTaskLog();
      scheduleTaskLogPoll();
    }, 2000);
  }

  function stopTaskLogPoll() {
    if (taskLogTimer) {
      clearTimeout(taskLogTimer);
      taskLogTimer = null;
    }
  }

  function normalizeInterval(): void {
    // P2-1: clamp the state itself, not just the scheduler, so the shareable
    // URL and the bound input can never hold 0.1 / NaN.
    const v = Number(pollInterval);
    pollInterval = Number.isFinite(v) && v > 0 ? Math.max(v, 0.5) : 2;
  }

  function updateUrl() {
    if (!browser) return;
    normalizeInterval();
    const url = new URL(window.location.href);
    if (assignee) url.searchParams.set("assignee", assignee);
    else url.searchParams.delete("assignee");
    if (tenant && flags.tenantNamespace) url.searchParams.set("tenant", tenant);
    else url.searchParams.delete("tenant");
    if (kinds) url.searchParams.set("kinds", kinds);
    else url.searchParams.delete("kinds");
    url.searchParams.set("interval", String(pollInterval));
    if (tailBytes) url.searchParams.set("tailBytes", String(tailBytes));
    else url.searchParams.delete("tailBytes");
    if (selectedTaskId !== null) url.searchParams.set("task", String(selectedTaskId));
    else url.searchParams.delete("task");
    history.replaceState(history.state, "", url);
  }

  function applyFilters() {
    // New filter set: invalidate any in-flight board fetch and start clean.
    boardGen++;
    events = [];
    streamError = null;
    normalizeInterval();
    updateUrl();
    fetchBoardEvents();
  }

  function selectTask(id: number) {
    selectedTaskId = id;
    selectedTask = null;
    taskLoading = true;
    taskEvents = [];
    taskLog = null;
    taskError = null;
    taskEventsError = null;
    logError = null;
    taskEventsFollow = true;
    taskLogFollow = true;
    updateUrl();
    fetchSelectedTask();
    fetchTaskEvents();
    if (flags.workerLogCapture) fetchTaskLog();
  }

  onMount(() => {
    hidden = document.hidden;
    const listener = () => {
      hidden = document.hidden;
    };
    document.addEventListener("visibilitychange", listener);
    if (board && live) fetchBoardEvents();
    if (board && selectedTaskId !== null) {
      fetchSelectedTask();
      fetchTaskEvents();
      if (flags.workerLogCapture) fetchTaskLog();
    }
    return () => document.removeEventListener("visibilitychange", listener);
  });

  $effect(() => {
    if (!browser || !board) return;
    if (live && !hidden) {
      scheduleBoardPoll();
    } else {
      stopBoardPoll();
    }
    return () => stopBoardPoll();
  });

  $effect(() => {
    if (!browser || !board || selectedTaskId === null) return;
    scheduleTaskEventsPoll();
    return () => stopTaskEventsPoll();
  });

  $effect(() => {
    if (!browser || !board || selectedTaskId === null || !flags.workerLogCapture) return;
    scheduleTaskLogPoll();
    return () => stopTaskLogPoll();
  });
</script>

<svelte:head>
  <title>Activity — kdi</title>
</svelte:head>

{#if error}
  <div class="stack-md">
    <h1>Board not found</h1>
    <p class="error">{error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else if board}
  <div class="stack-md">
    <div class="flex-between">
      <div>
        <h1>Activity</h1>
        <p class="text-dim">Board: <code>{board.slug}</code></p>
      </div>
      <div class="actions">
        <span class="badge" class:warn={!live}>{live ? "LIVE" : "PAUSED"}</span>
        <button class="btn" type="button" onclick={() => (live = !live)} aria-pressed={live}>
          {live ? "Pause" : "Resume"}
        </button>
        <button class="btn btn--primary" type="button" onclick={fetchBoardEvents} disabled={live}>
          Refresh
        </button>
      </div>
    </div>

    {#if flags.watchFilters}
      <div class="filters">
        <label class="form-group">
          Assignee
          <input type="text" placeholder="profile" bind:value={assignee} />
        </label>
        {#if flags.tenantNamespace}
          <label class="form-group">
            Tenant
            <input type="text" placeholder="tenant" bind:value={tenant} />
          </label>
        {/if}
        <label class="form-group">
          Kinds
          <input type="text" placeholder="created,promoted" bind:value={kinds} />
        </label>
        <label class="form-group">
          Interval (s)
          <input
            type="number"
            min="0.5"
            step="0.5"
            bind:value={pollInterval}
            onchange={updateUrl}
          />
        </label>
        <button class="btn" type="button" onclick={applyFilters}>Apply</button>
      </div>
    {/if}

    {#if streamError}
      <p class="error">{streamError} <button class="btn" type="button" onclick={fetchBoardEvents}>Retry</button></p>
    {/if}

    <div class="activity-grid">
      <section class="stream" aria-labelledby="stream-heading">
        <h2 id="stream-heading" class="stack-sm">Board events</h2>
        {#if events.length === 0}
          <div class="placeholder">
            {#if flags.watchFilters && (assignee || (tenant && flags.tenantNamespace) || kinds)}
              No matching events
            {:else}
              No events yet
            {/if}
          </div>
        {:else}
          <ul class="event-list" role="list">
            {#each events as event (event.id)}
              <li class="event-row" class:selected={selectedTaskId === event.taskId}>
                <button
                  type="button"
                  class="event-select"
                  onclick={() => selectTask(event.taskId)}
                  aria-label="Select task {event.taskId}"
                >
                  <span class="event-task">#{event.taskId}</span>
                  <span class="badge">{event.kind}</span>
                  <span class="text-dim">{formatAge(event.createdAt)}</span>
                  <span class="event-payload">{payloadPreview(event.payload)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <aside class="task-pane" aria-labelledby="task-pane-heading">
        <h2 id="task-pane-heading" class="stack-sm">Task detail</h2>
        {#if selectedTaskId === null}
          <div class="placeholder">Select a task from the stream to inspect events and logs.</div>
        {:else if taskLoading}
          <div class="placeholder">Loading task…</div>
        {:else if selectedTask}
          <div class="task-header">
            <h3>#{selectedTask.id} {selectedTask.title}</h3>
            <div class="actions">
              <span class="badge">{statusLabel(selectedTask.status)}</span>
              {#if selectedTask.assignee}
                <span class="badge">{selectedTask.assignee}</span>
              {/if}
              <a href="/boards/{board.slug}/tasks/{selectedTask.id}/edit" class="btn">Open</a>
            </div>
          </div>

          <div class="task-section">
            <div class="flex-between">
              <h4>Events</h4>
              <div class="actions">
                {#if flags.tailNoFollow}
                  <button
                    class="btn"
                    type="button"
                    onclick={() => {
                      taskEventsFollow = !taskEventsFollow;
                      if (taskEventsFollow) scheduleTaskEventsPoll();
                    }}
                  >
                    {taskEventsFollow ? "Pause" : "Follow"}
                  </button>
                {:else}
                  <span class="badge">Following</span>
                {/if}
              </div>
            </div>
            {#if taskEventsError}
              <p class="error">{taskEventsError} <button class="btn" type="button" onclick={fetchTaskEvents}>Retry</button></p>
            {:else if taskEvents.length === 0}
              <p class="text-dim">No events yet.</p>
            {:else}
              <ul class="task-event-list" role="list">
                {#each taskEvents as e (e.id)}
                  <li class="task-event">
                    <span class="badge">{e.kind}</span>
                    <span class="text-dim">{formatAge(e.createdAt)}</span>
                    <span class="event-payload">{payloadPreview(e.payload)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          {#if flags.workerLogCapture}
            <div class="task-section">
              <div class="flex-between">
                <h4>Worker log</h4>
                <div class="actions">
                  <button
                    class="btn"
                    type="button"
                    onclick={() => {
                      taskLogFollow = !taskLogFollow;
                      if (taskLogFollow) scheduleTaskLogPoll();
                    }}
                  >
                    {taskLogFollow ? "Pause" : "Follow"}
                  </button>
                  <label class="inline-label">
                    Tail bytes
                    <input
                      type="number"
                      min="0"
                      step="256"
                      bind:value={tailBytes}
                      onchange={updateUrl}
                    />
                  </label>
                </div>
              </div>
              {#if logError}
                <p class="error">{logError} <button class="btn" type="button" onclick={fetchTaskLog}>Retry</button></p>
              {:else if taskLog?.present}
                <pre class="log"><code>{taskLog.content}</code></pre>
              {:else}
                <p class="text-dim">No log captured yet.</p>
              {/if}
            </div>
          {/if}
        {:else if taskError}
          <div class="placeholder">
            <p class="error">{taskError}</p>
            <button class="btn" type="button" onclick={fetchSelectedTask}>Retry</button>
          </div>
        {:else}
          <div class="placeholder">Task not found.</div>
        {/if}
      </aside>
    </div>
  </div>
{:else}
  <div class="stack-md">
    <h1>No board selected</h1>
    <p class="text-dim">Choose a board from the switcher or <a href="/boards">view all boards</a>.</p>
  </div>
{/if}

<style>
  .activity-grid {
    display: grid;
    grid-template-columns: 1fr 360px;
    gap: 18px;
    align-items: start;
  }
  .stream,
  .task-pane {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 16px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
  }
  .filters .form-group {
    margin-bottom: 0;
  }
  .event-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .event-row {
    border-bottom: 1px solid var(--border);
  }
  .event-row:last-child {
    border-bottom: none;
  }
  .event-row.selected {
    background: var(--accent-muted);
  }
  .event-select {
    width: 100%;
    display: grid;
    grid-template-columns: 60px auto auto 1fr;
    gap: 12px;
    align-items: baseline;
    padding: 10px 12px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
  }
  .event-select:hover {
    background: var(--surface-2);
  }
  .event-task {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .event-payload {
    color: var(--text-dim);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-pane h3 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  .task-header {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .task-section {
    margin-bottom: 16px;
  }
  .task-section h4 {
    margin: 0;
    font-size: 14px;
  }
  .task-event-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .task-event {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .task-event:last-child {
    border-bottom: none;
  }
  .log {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    overflow: auto;
    max-height: 320px;
    font-size: 12px;
    font-family: var(--font-mono);
    margin: 0;
  }
  .inline-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .inline-label input {
    width: 80px;
  }
  @media (max-width: 768px) {
    .activity-grid {
      grid-template-columns: 1fr;
    }
    .event-select {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
