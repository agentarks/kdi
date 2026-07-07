<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageData, ActionData } from "./$types";

  interface Props {
    data: PageData;
    form: ActionData;
  }

  let { data, form }: Props = $props();

  const statuses = ["triage", "todo", "scheduled", "ready", "running", "done", "blocked", "review"] as const;

  let values = $state({
    title: "",
    body: "",
    assignee: "",
    status: "todo",
    scheduled_at: "",
    priority: "",
    tenant: "",
    created_by: "",
    skills: "",
    model_override: "",
    max_runtime: "",
    max_retries: "",
    workspace: "",
    session_id: "",
    workflow_template_id: "",
    step_key: "",
    goal_mode: false,
    goal_max_turns: "",
    goal_judge_profile: "",
    parent_ids: "",
  });

  $effect(() => {
    if (form?.values) {
      values = Object.fromEntries(
        Object.entries(form.values).map(([k, v]) => [
          k,
          k === "goal_mode" ? v === "on" : (v ?? ""),
        ]),
      ) as typeof values;
    }
  });

  let selectedTemplate = $derived(
    data.templates.find((t) => t.templateId === values.workflow_template_id),
  );
</script>

<svelte:head>
  <title>New task — {data.board.name}</title>
</svelte:head>

<div class="stack-md">
  <div class="stack-sm">
    <a href="/boards/{data.board.slug}">← Back to board</a>
    <h1>Create task on {data.board.name}</h1>
  </div>

  {#if form?.error}
    <div class="placeholder" style="padding: 12px; text-align: left;">
      <strong>Error:</strong> {form.error}
    </div>
  {/if}

  <form method="POST" action="?/" use:enhance class="stack-md">
    <div class="stack-sm">
      <label for="title">Title</label>
      <input
        id="title"
        name="title"
        type="text"
        required
        bind:value={values.title}
      />
    </div>

    <div class="stack-sm">
      <label for="body">Body</label>
      <textarea id="body" name="body" rows="4" bind:value={values.body}></textarea>
    </div>

    <div class="stack-sm">
      <label for="assignee">Assignee</label>
      <input id="assignee" name="assignee" type="text" bind:value={values.assignee} />
    </div>

    <div class="stack-sm">
      <label for="status">Status</label>
      <select id="status" name="status" bind:value={values.status}>
        {#each statuses as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </div>

    <div class="stack-sm">
      <label for="scheduled_at">Scheduled at</label>
      <input
        id="scheduled_at"
        name="scheduled_at"
        type="datetime-local"
        disabled={!data.flags.scheduledStatus}
        bind:value={values.scheduled_at}
      />
      {#if !data.flags.scheduledStatus}
        <span class="text-dim">Requires FF_SCHEDULED_STATUS</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="priority">Priority</label>
      <input
        id="priority"
        name="priority"
        type="number"
        disabled={!data.flags.priorityInteger}
        bind:value={values.priority}
      />
      {#if !data.flags.priorityInteger}
        <span class="text-dim">Requires FF_PRIORITY_INTEGER</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="tenant">Tenant</label>
      <input
        id="tenant"
        name="tenant"
        type="text"
        disabled={!data.flags.tenantNamespace}
        bind:value={values.tenant}
      />
      {#if !data.flags.tenantNamespace}
        <span class="text-dim">Requires FF_TENANT_NAMESPACE</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="created_by">Created by</label>
      <input
        id="created_by"
        name="created_by"
        type="text"
        disabled={!data.flags.createdBy}
        bind:value={values.created_by}
      />
      {#if !data.flags.createdBy}
        <span class="text-dim">Requires FF_CREATED_BY</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="skills">Skills (comma-separated)</label>
      <input
        id="skills"
        name="skills"
        type="text"
        disabled={!data.flags.skillsArray}
        bind:value={values.skills}
      />
      {#if !data.flags.skillsArray}
        <span class="text-dim">Requires FF_SKILLS_ARRAY</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="model_override">Model override</label>
      <input
        id="model_override"
        name="model_override"
        type="text"
        disabled={!data.flags.modelOverride}
        bind:value={values.model_override}
      />
      {#if !data.flags.modelOverride}
        <span class="text-dim">Requires FF_MODEL_OVERRIDE</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="max_runtime">Max runtime (e.g. 30m, 1h, 90s)</label>
      <input
        id="max_runtime"
        name="max_runtime"
        type="text"
        disabled={!data.flags.maxRuntime}
        bind:value={values.max_runtime}
      />
      {#if !data.flags.maxRuntime}
        <span class="text-dim">Requires FF_MAX_RUNTIME</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="max_retries">Max retries</label>
      <input
        id="max_retries"
        name="max_retries"
        type="number"
        disabled={!data.flags.maxRetries}
        bind:value={values.max_retries}
      />
      {#if !data.flags.maxRetries}
        <span class="text-dim">Requires FF_MAX_RETRIES</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="workspace">Workspace</label>
      <input
        id="workspace"
        name="workspace"
        type="text"
        disabled={!data.flags.defaultWorkdir}
        bind:value={values.workspace}
      />
      {#if !data.flags.defaultWorkdir}
        <span class="text-dim">Requires FF_DEFAULT_WORKDIR</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="session_id">Session ID</label>
      <input
        id="session_id"
        name="session_id"
        type="text"
        disabled={!data.flags.listFiltersSort}
        bind:value={values.session_id}
      />
      {#if !data.flags.listFiltersSort}
        <span class="text-dim">Requires FF_LIST_FILTERS_SORT</span>
      {/if}
    </div>

    <div class="stack-sm">
      <label for="workflow_template_id">Workflow template</label>
      <select
        id="workflow_template_id"
        name="workflow_template_id"
        disabled={!data.flags.workflowTemplates}
        bind:value={values.workflow_template_id}
      >
        <option value="">—</option>
        {#each data.templates as t}
          <option value={t.templateId}>{t.name} ({t.templateId})</option>
        {/each}
      </select>
      {#if !data.flags.workflowTemplates}
        <span class="text-dim">Requires FF_WORKFLOW_TEMPLATES</span>
      {/if}
    </div>

    {#if selectedTemplate}
      <div class="stack-sm">
        <label for="step_key">Step key</label>
        <select id="step_key" name="step_key" bind:value={values.step_key}>
          <option value="">First step ({selectedTemplate.steps[0]})</option>
          {#each selectedTemplate.steps as step}
            <option value={step}>{step}</option>
          {/each}
        </select>
      </div>
    {/if}

    <div class="stack-sm">
      <label for="goal_mode">
        <input
          id="goal_mode"
          name="goal_mode"
          type="checkbox"
          disabled={!data.flags.goalMode}
          bind:checked={values.goal_mode}
        />
        Goal mode
      </label>
      {#if !data.flags.goalMode}
        <span class="text-dim">Requires FF_GOAL_MODE</span>
      {/if}
    </div>

    {#if values.goal_mode}
      <div class="stack-sm">
        <label for="goal_max_turns">Goal max turns</label>
        <input
          id="goal_max_turns"
          name="goal_max_turns"
          type="number"
          bind:value={values.goal_max_turns}
        />
      </div>
      <div class="stack-sm">
        <label for="goal_judge_profile">Goal judge profile</label>
        <select id="goal_judge_profile" name="goal_judge_profile" bind:value={values.goal_judge_profile}>
          <option value="">—</option>
          {#each data.profiles as p}
            <option value={p.name}>{p.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <div class="stack-sm">
      <label for="parent_ids">Parent task IDs (comma-separated)</label>
      <input
        id="parent_ids"
        name="parent_ids"
        type="text"
        disabled={!data.flags.createParent}
        bind:value={values.parent_ids}
      />
      {#if !data.flags.createParent}
        <span class="text-dim">Requires FF_CREATE_PARENT</span>
      {/if}
    </div>

    <div class="stack-sm">
      <button type="submit" class="btn btn--primary">Create task</button>
      <a href="/boards/{data.board.slug}" class="btn" role="button">Cancel</a>
    </div>
  </form>
</div>

<style>
  label {
    display: block;
    margin-bottom: 4px;
    color: var(--text-dim);
    font-size: 13px;
  }
  input,
  select,
  textarea {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text);
  }
  input:disabled,
  select:disabled,
  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  input[type="checkbox"] {
    width: auto;
    margin-right: 8px;
  }
</style>
