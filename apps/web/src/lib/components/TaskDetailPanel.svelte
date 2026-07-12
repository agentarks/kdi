<script lang="ts">
  import { formatAge, formatDate, formatBytes, statusLabel } from "$lib/kanban";
  import TaskActions from "$lib/components/TaskActions.svelte";
  import type { TaskDetail, DetailFlags, LogResponse, TaskDetailRun, TaskDetailEvent, LifecycleFlags } from "$lib/types";

  interface Props {
    detail: TaskDetail;
    flags: DetailFlags;
    lifecycle: LifecycleFlags;
    boardSlug: string;
    currentProfile: string;
  }

  let { detail, flags, lifecycle, boardSlug, currentProfile }: Props = $props();

  const task = $derived(detail.task);
  const age = $derived(formatAge(task.createdAt));
  const createdDate = $derived(formatDate(task.createdAt));
  const isBlocked = $derived(task.status === "blocked");
  const blockedParents = $derived(detail.parents.filter((p) => p.status !== "done"));

  // Runs filter state
  let runs = $state<TaskDetailRun[]>([]);
  let runFilterType = $state<"" | "status" | "outcome">("");
  let runFilterName = $state("");
  let runFilterLoading = $state(false);

  // Event stream state
  let events = $state<TaskDetailEvent[]>([]);
  let eventFollowing = $state(false);
  let eventInterval = $state<ReturnType<typeof setInterval> | null>(null);

  // Worker log state
  let logPresent = $state(false);
  let logContent = $state<string | null>(null);
  let logFollowing = $state(false);
  let logTailBytes = $state(8192);
  let logInterval = $state<ReturnType<typeof setInterval> | null>(null);
  let logTruncated = $state(false);
  let logSize = $state<number | undefined>(undefined);

  $effect(() => {
    runs = detail.runs;
    events = detail.events;
    logPresent = detail.log.present;
  });

  $effect(() => {
    // Fetch initial log once if present (non-follow, default tail)
    if (logPresent && logContent === null && flags.workerLogCapture) {
      void refreshLog();
    }
  });

  $effect(() => {
    // Cleanup intervals on unmount only
    return () => {
      if (eventInterval) clearInterval(eventInterval);
      if (logInterval) clearInterval(logInterval);
    };
  });

  function taskHref(id: number) {
    return `/tasks/${id}?board=${boardSlug}`;
  }

  function statusBadgeClass(status: string): string {
    if (status === "blocked" || status === "failed" || status === "crashed") return "badge warn";
    if (status === "done" || status === "completed") return "badge success";
    return "badge";
  }

  function metadataEntries() {
    const out: { label: string; value: string | number }[] = [];
    if (task.workspaceKind) out.push({ label: "Workspace kind", value: task.workspaceKind });
    if (task.workspace) out.push({ label: "Workspace", value: task.workspace });
    if (task.branch) out.push({ label: "Branch", value: task.branch });
    if (task.maxRuntimeSeconds !== null && flags.maxRuntime) out.push({ label: "Max runtime", value: `${task.maxRuntimeSeconds}s` });
    if (task.maxRetries !== null && flags.maxRetries) out.push({ label: "Max retries", value: task.maxRetries });
    if (task.consecutiveFailures) out.push({ label: "Consecutive failures", value: task.consecutiveFailures });
    if (task.skills.length > 0 && flags.skillsArray) out.push({ label: "Skills", value: task.skills.join(", ") });
    if (task.modelOverride && flags.modelOverride) out.push({ label: "Model override", value: task.modelOverride });
    if (task.sessionId) out.push({ label: "Session", value: task.sessionId });
    if (task.workflowTemplateId && flags.workflowTemplates) out.push({ label: "Workflow template", value: task.workflowTemplateId });
    if (task.currentStepKey && flags.workflowTemplates) out.push({ label: "Current step", value: task.currentStepKey });
    if (task.claimLock) out.push({ label: "Claim lock", value: task.claimLock });
    if (task.claimExpires) out.push({ label: "Claim expires", value: formatDate(task.claimExpires) });
    if (task.lastHeartbeatAt && flags.heartbeat) out.push({ label: "Last heartbeat", value: formatDate(task.lastHeartbeatAt) });
    if (task.goalMode && flags.goalMode) {
      if (task.goalMaxTurns !== null) out.push({ label: "Goal max turns", value: task.goalMaxTurns });
      if (task.goalRemainingTurns !== null) out.push({ label: "Goal remaining turns", value: task.goalRemainingTurns });
      if (task.goalJudgeProfile) out.push({ label: "Goal judge", value: task.goalJudgeProfile });
    }
    return out;
  }

  const metadata = $derived(metadataEntries());

  async function applyRunFilter() {
    if (!runFilterType || !runFilterName) return;
    runFilterLoading = true;
    try {
      const res = await fetch(`/api/boards/${boardSlug}/tasks/${task.id}/runs?stateType=${runFilterType}&stateName=${encodeURIComponent(runFilterName)}`);
      const data = await res.json();
      runs = data.runs;
    } finally {
      runFilterLoading = false;
    }
  }

  function clearRunFilter() {
    runFilterType = "";
    runFilterName = "";
    runs = detail.runs;
  }

  async function refreshEvents() {
    const lastId = events[0]?.id ?? 0;
    const res = await fetch(`/api/boards/${boardSlug}/tasks/${task.id}/events?since=${lastId}`);
    const data = await res.json();
    const newEvents = (data.events as typeof events).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    events = [...newEvents, ...events];
  }

  function toggleEventFollow() {
    eventFollowing = !eventFollowing;
    if (eventInterval) {
      clearInterval(eventInterval);
      eventInterval = null;
    }
    if (eventFollowing) {
      eventInterval = setInterval(() => void refreshEvents(), 2000);
    }
  }

  async function refreshLog() {
    const url = logTailBytes > 0
      ? `/api/boards/${boardSlug}/tasks/${task.id}/log?tail=${logTailBytes}`
      : `/api/boards/${boardSlug}/tasks/${task.id}/log`;
    try {
      const res = await fetch(url);
      const data: LogResponse = await res.json();
      logPresent = data.present;
      logContent = data.present ? data.content ?? "" : null;
      logTruncated = data.truncated ?? false;
      logSize = data.size;
    } catch (err) {
      console.error("Log refresh failed:", err);
    }
  }

  function toggleLogFollow() {
    logFollowing = !logFollowing;
    if (logInterval) {
      clearInterval(logInterval);
      logInterval = null;
    }
    if (logFollowing) {
      logInterval = setInterval(() => void refreshLog(), 2000);
    }
  }

  function payloadPreview(payload: string | null): string {
    if (!payload) return "—";
    return payload.length > 120 ? payload.slice(0, 120) + "…" : payload;
  }
</script>

<div class="detail-panel">
  <header class="detail-header detail-section">
    <div class="header-main">
      <h1 class="task-title">#{task.id} {task.title}</h1>
      <div class="header-badges">
        <span class={statusBadgeClass(task.status)}>{statusLabel(task.status)}</span>
        <span class="badge">P{task.priority}</span>
        {#if task.assignee}
          <span class="badge">@{task.assignee}</span>
        {:else}
          <span class="badge">unassigned</span>
        {/if}
        {#if task.tenant && flags.tenantNamespace}
          <span class="badge tenant">{task.tenant}</span>
        {/if}
        {#if task.createdBy && flags.createdBy}
          <span class="badge created-by">@{task.createdBy}</span>
        {/if}
      </div>
    </div>
    <div class="header-meta">
      <span class="text-dim">Created {createdDate} ({age})</span>
    </div>
  </header>

  {#if task.blockReason && task.status === "blocked"}
    <div class="detail-section reason-section">
      <span class="badge reason">Blocked:</span>
      <span>{task.blockReason}</span>
    </div>
  {/if}
  {#if task.scheduleReason && task.status === "scheduled"}
    <div class="detail-section reason-section">
      <span class="badge reason">Scheduled:</span>
      <span>{task.scheduleReason}</span>
      {#if task.scheduledAt && flags.scheduledStatus}
        <span class="text-dim">at {formatDate(task.scheduledAt)}</span>
      {/if}
    </div>
  {/if}
  {#if task.reviewReason && task.status === "review"}
    <div class="detail-section reason-section">
      <span class="badge reason">Review:</span>
      <span>{task.reviewReason}</span>
    </div>
  {/if}
  {#if task.rateLimitedUntil && flags.rateLimitExitCode}
    <div class="detail-section reason-section">
      <span class="badge rate-limited">Rate limited until {formatDate(task.rateLimitedUntil)}</span>
    </div>
  {/if}

  <TaskActions {task} flags={lifecycle} {boardSlug} {currentProfile} hasBlockingDeps={blockedParents.length > 0} />

  <section class="detail-section" aria-labelledby="body-heading">
    <h2 id="body-heading">Body</h2>
    {#if task.body}
      <pre class="plain-text">{task.body}</pre>
    {:else}
      <p class="empty-state">No body</p>
    {/if}
  </section>

  <section class="detail-section" aria-labelledby="result-heading">
    <h2 id="result-heading">Result</h2>
    {#if task.result}
      <pre class="plain-text">{task.result}</pre>
    {:else}
      <p class="empty-state">No result captured</p>
    {/if}
  </section>

  <section class="detail-section" aria-labelledby="summary-heading">
    <h2 id="summary-heading">Summary</h2>
    {#if task.summary}
      <pre class="plain-text">{task.summary}</pre>
    {:else}
      <p class="empty-state">No summary</p>
    {/if}
  </section>

  <section class="detail-section" aria-labelledby="metadata-heading">
    <h2 id="metadata-heading">Metadata</h2>
    {#if metadata.length > 0}
      <dl class="metadata-grid">
        {#each metadata as item}
          <div class="metadata-item">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        {/each}
      </dl>
    {:else}
      <p class="empty-state">No additional metadata</p>
    {/if}
  </section>

  <section class="detail-section" aria-labelledby="comments-heading">
    <h2 id="comments-heading">Comments</h2>
    {#if detail.comments.length > 0}
      <ul class="comment-list">
        {#each detail.comments as comment}
          <li class="comment-row">
            <div class="comment-meta">
              <strong>{flags.commentEnhancements ? comment.author ?? "user" : "user"}</strong>
              <span class="text-dim">{formatDate(comment.createdAt)}</span>
            </div>
            <p class="comment-text">{comment.text}</p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty-state">No comments yet</p>
    {/if}
  </section>

  {#if flags.taskAttachments}
    <section class="detail-section" aria-labelledby="attachments-heading">
      <h2 id="attachments-heading">Attachments</h2>
      {#if detail.attachments.length > 0}
        <table class="table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Size</th>
              <th>Type</th>
              <th>Uploader</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {#each detail.attachments as attachment}
              <tr>
                <td>{attachment.filename}</td>
                <td>{formatBytes(attachment.size)}</td>
                <td>{attachment.contentType ?? "unknown"}</td>
                <td>{attachment.uploadedBy ?? "unknown"}</td>
                <td>{formatDate(attachment.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="empty-state">No attachments</p>
      {/if}
    </section>
  {/if}

  <section class="detail-section" aria-labelledby="dependencies-heading">
    <h2 id="dependencies-heading">Dependencies</h2>
    {#if isBlocked && blockedParents.length > 0}
      <div class="blocking-callout">
        <span class="badge warn">Blocked by dependencies</span>
        <span>{blockedParents.length} parent task(s) not done</span>
      </div>
    {/if}
    <div class="dependency-lists">
      <div>
        <h3>Parent tasks</h3>
        {#if detail.parents.length > 0}
          <ul class="link-list">
            {#each detail.parents as parent}
              <li>
                <a href={taskHref(parent.id)} class={parent.status === "blocked" ? "blocked-link" : ""}>#{parent.id} {parent.title}</a>
                <span class="badge">{parent.status}</span>
                {#if isBlocked && parent.status !== "done"}
                  <span class="badge warn">blocking</span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty-state">No parent dependencies</p>
        {/if}
      </div>
      <div>
        <h3>Child tasks</h3>
        {#if detail.children.length > 0}
          <ul class="link-list">
            {#each detail.children as child}
              <li>
                <a href={taskHref(child.id)} class={child.status === "blocked" ? "blocked-link" : ""}>#{child.id} {child.title}</a>
                <span class={child.status === "blocked" ? "badge warn" : "badge"}>{child.status}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty-state">No child tasks</p>
        {/if}
      </div>
    </div>
  </section>

  {#if flags.contextBuilder && (detail.context || detail.contextError)}
    <section class="detail-section" aria-labelledby="context-heading">
      <h2 id="context-heading">Context</h2>
      {#if detail.contextError}
        <div class="reason-section">
          <span class="badge warn">Context not available</span>
        </div>
      {:else if detail.context}
        {@const ctx = detail.context}
        <div class="context-summary">
          <span class="badge">{ctx.parents.length} parents</span>
          <span class="badge">{ctx.priorAttempts.length} prior attempts</span>
          <span class="badge">{ctx.roleHistory.length} role history</span>
          <span class="badge">{ctx.comments.length} comments</span>
          <span class="badge">{ctx.attachments.length} attachments</span>
        </div>
        {#if ctx.body}
          <pre class="plain-text context-body">{ctx.body}</pre>
        {/if}
      {/if}
    </section>
  {/if}

  <section class="detail-section" aria-labelledby="runs-heading">
    <div class="section-header">
      <h2 id="runs-heading">Runs</h2>
      {#if flags.showRunFiltering}
        <div class="run-filter">
          <label class="sr-only" for="run-filter-type">Filter by</label>
          <select id="run-filter-type" bind:value={runFilterType}>
            <option value="">—</option>
            <option value="status">Status</option>
            <option value="outcome">Outcome</option>
          </select>
          <label class="sr-only" for="run-filter-name">Value</label>
          <input id="run-filter-name" type="text" bind:value={runFilterName} placeholder="value" />
          <button class="btn" type="button" onclick={applyRunFilter} disabled={runFilterLoading || !runFilterType || !runFilterName}>Filter</button>
          <button class="btn" type="button" onclick={clearRunFilter}>Clear</button>
        </div>
      {/if}
    </div>
    {#if runs.length > 0}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Profile</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>Step</th>
              <th>Started</th>
              <th>Ended</th>
              <th>PID</th>
              <th>Spawned</th>
              <th>Summary</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {#each runs as run}
              <tr>
                <td>{run.id}</td>
                <td>{run.profile ?? "—"}</td>
                <td>{run.status}</td>
                <td>{run.outcome ?? "—"}</td>
                <td>{run.stepKey ?? "—"}</td>
                <td>{formatDate(run.startedAt)}</td>
                <td>{run.endedAt ? formatDate(run.endedAt) : "—"}</td>
                <td>{run.workerPid ?? "—"}</td>
                <td>{run.spawnedAt ? formatDate(run.spawnedAt) : "—"}</td>
                <td>{run.summary ?? "—"}</td>
                <td>{run.error ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty-state">No runs recorded</p>
    {/if}
  </section>

  <section class="detail-section" aria-labelledby="events-heading">
    <div class="section-header">
      <h2 id="events-heading">Events</h2>
      <button class="btn" type="button" onclick={toggleEventFollow}>
        {eventFollowing ? "Pause" : "Follow"}
      </button>
    </div>
    {#if events.length > 0}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Payload</th>
              <th>Run</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {#each events as event}
              <tr>
                <td>{event.kind}</td>
                <td class="payload-cell">{payloadPreview(event.payload)}</td>
                <td>{event.runId ?? "—"}</td>
                <td>{formatDate(event.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty-state">No events</p>
    {/if}
  </section>

  {#if flags.workerLogCapture}
    <section class="detail-section" aria-labelledby="log-heading">
      <div class="section-header">
        <h2 id="log-heading">Worker log</h2>
        <div class="log-controls">
          <label class="sr-only" for="log-tail">Tail bytes</label>
          <input id="log-tail" type="number" min="0" bind:value={logTailBytes} />
          <button class="btn" type="button" onclick={refreshLog} disabled={!logPresent}>Refresh</button>
          <button class="btn" type="button" onclick={toggleLogFollow} disabled={!logPresent}>
            {logFollowing ? "Stop" : "Follow"}
          </button>
        </div>
      </div>
      {#if logPresent}
        {#if logContent !== null}
          {#if logTruncated}
            <p class="text-dim">Log truncated; file size {formatBytes(logSize ?? 0)}</p>
          {/if}
          <pre class="plain-text log-text">{logContent}</pre>
        {:else}
          <p class="empty-state">Loading log…</p>
        {/if}
      {:else}
        <p class="empty-state">No log captured yet</p>
      {/if}
    </section>
  {/if}

  {#if flags.worktreeHandoff && detail.handoff}
    <section class="detail-section" aria-labelledby="handoff-heading">
      <h2 id="handoff-heading">Worktree handoff</h2>
      <dl class="metadata-grid">
        <div class="metadata-item">
          <dt>Branch</dt>
          <dd>{detail.handoff.branch}</dd>
        </div>
        <div class="metadata-item">
          <dt>Worktree path</dt>
          <dd><code>{detail.handoff.worktreePath}</code></dd>
        </div>
        <div class="metadata-item">
          <dt>Handed off</dt>
          <dd>{formatDate(detail.handoff.eventAt)}</dd>
        </div>
      </dl>
    </section>
  {/if}
</div>

<style>
  .detail-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .detail-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 16px;
  }
  .detail-section h2 {
    margin: 0 0 12px;
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    font-family: var(--font-ui);
  }
  .detail-section h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    font-family: var(--font-ui);
  }
  .detail-header {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .header-main {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .task-title {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    font-family: var(--font-ui);
  }
  .header-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .header-meta {
    font-size: 13px;
  }
  .reason-section {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .plain-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    max-height: 360px;
    overflow: auto;
    background: var(--surface-2);
    padding: 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .empty-state {
    color: var(--text-dim);
    margin: 8px 0 0;
    font-size: 13px;
  }
  .metadata-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin: 0;
  }
  .metadata-item dt {
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    margin-bottom: 2px;
  }
  .metadata-item dd {
    margin: 0;
    font-size: 13px;
  }
  .comment-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .comment-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .comment-meta {
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 12px;
  }
  .comment-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
  }
  .dependency-lists {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }
  .link-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .link-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .blocked-link {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .blocking-callout {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .section-header h2 {
    margin-bottom: 0;
  }
  .run-filter,
  .log-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .run-filter select,
  .run-filter input,
  .log-controls input {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
    padding: 5px 10px;
    font-size: 13px;
  }
  .log-controls input {
    width: 90px;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .payload-cell {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }
  .context-body {
    max-height: 240px;
  }
  .log-text {
    max-height: 480px;
  }
  @media (max-width: 768px) {
    .header-main {
      flex-direction: column;
      align-items: stretch;
    }
    .metadata-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
