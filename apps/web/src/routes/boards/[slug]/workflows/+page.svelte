<script lang="ts">
  // KDI-UI-013 Slice 1: workflow templates list + define form.
  import { page } from "$app/state";
  import type { FormResult } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const formResult = $derived(form as FormResult | undefined);
  const values = $derived(formResult?.values ?? {});
  const error = $derived(formResult?.error);
  // FR-13: success toast via the ?success= query param (matches boards/+page.svelte).
  const success = $derived(page.url.searchParams.get("success") ?? undefined);

  const board = $derived(data.board);
  const templates = $derived(data.templates ?? []);
  const enabled = $derived(data.flags?.workflowTemplates ?? false);

  // FR-8: warn when the typed template_id matches an existing template (upsert).
  const existingIds = $derived(new Set(templates.map((t) => t.templateId)));
  // FR-13: preserve template_id on failure; seed from preserved form values
  // and bind for the live FR-8 overwrite warning. Snapshot the value once so the
  // bind stays editable (not reactive to values).
  // svelte-ignore state_referenced_locally
  const initialTemplateId = (values.template_id as string) ?? "";
  let templateIdInput = $state(initialTemplateId);
  const overwriteWarning = $derived(
    enabled && templateIdInput !== "" && existingIds.has(templateIdInput),
  );
</script>

<svelte:head>
  <title>{board ? `Workflows — ${board.name || board.slug}` : "Board not found"} — kdi</title>
</svelte:head>

{#if data.error}
  <div class="stack-md">
    <h1>Board not found</h1>
    <p class="error">{data.error}</p>
    <p><a href="/boards">← Back to boards</a></p>
  </div>
{:else if board}
  <div class="stack-md">
    <div class="flex-between">
      <h1>Workflow templates — {board.name || board.slug}</h1>
      <div class="actions">
        <a href="/boards/{board.slug}" class="btn">← Back to board</a>
      </div>
    </div>

    {#if success}
      <p class="success" role="status">{success}</p>
    {/if}

    {#if !enabled}
      <!-- AC-13: disabled payload when the flag is off. -->
      <p class="text-dim" role="status">Workflow templates feature is not enabled.</p>
    {/if}

    <!-- FR-4: template list. -->
    {#if templates.length === 0}
      <!-- FR-5: empty state. -->
      <p class="text-dim">No workflow templates. Define one below.</p>
    {:else}
      <table class="workflow-table">
        <thead>
          <tr>
            <th scope="col">Template ID</th>
            <th scope="col">Name</th>
            <th scope="col">Steps</th>
          </tr>
        </thead>
        <tbody>
          {#each templates as template (template.id)}
            <tr>
              <td><code>{template.templateId}</code></td>
              <td>{template.name}</td>
              <td>{template.steps.join(" → ")}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <!-- FR-7: define form (gated by FF_WORKFLOW_TEMPLATES, AC-13). -->
    {#if enabled}
      <h2 class="stack-sm">Define template</h2>
      <form method="POST" action="/boards/{board.slug}/workflows?/define">
        <div class="form-group">
          <label for="template_id">Template ID</label>
          <input
            id="template_id"
            name="template_id"
            type="text"
            required
            maxlength="255"
            placeholder="e.g. code-review"
            bind:value={templateIdInput}
          />
          <p class="text-dim">Letters, numbers, underscores, and hyphens only.</p>
          {#if overwriteWarning}
            <p class="warn" role="status">An existing template has this ID — it will be overwritten.</p>
          {/if}
        </div>
        <div class="form-group">
          <label for="name">Name</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            maxlength="255"
            value={(values.name as string) ?? ""}
          />
        </div>
        <div class="form-group">
          <label for="steps">Steps (one key per line)</label>
          <textarea
            id="steps"
            name="steps"
            rows="5"
            required
            placeholder={"review\nfix\nmerge"}>{(values.steps as string) ?? ""}</textarea>
          <p class="text-dim">Up to 100 step keys. Empty lines are ignored.</p>
        </div>
        {#if error}
          <p class="error" role="alert">{error}</p>
        {/if}
        <div class="stack-sm">
          <button type="submit" class="btn btn--primary">Save template</button>
        </div>
      </form>
    {/if}
  </div>
{/if}

<style>
  .workflow-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .workflow-table th,
  .workflow-table td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .workflow-table th {
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
  }
  .workflow-table tbody tr:last-child td {
    border-bottom: none;
  }
  .warn {
    color: var(--accent-text);
    background: var(--accent-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    margin: 4px 0 0;
    font-size: 13px;
  }
</style>