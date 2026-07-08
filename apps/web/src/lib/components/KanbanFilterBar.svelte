<script lang="ts">
  import type { KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";
  import { STATUSES, VALID_SORT_KEYS, statusLabel } from "$lib/kanban";

  interface Props {
    filters: KanbanFilterState;
    assignees: Record<string, number>;
    profiles: string[];
    templates: KanbanTemplate[];
    currentProfile: string;
    capabilities: KanbanCapabilities;
  }

  let { filters, assignees, profiles, templates, currentProfile, capabilities }: Props = $props();

  function assigneeOptions(): string[] {
    const set = new Set<string>(profiles);
    for (const name of Object.keys(assignees)) set.add(name);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function selectedTemplate(id: string | null): KanbanTemplate | null {
    return templates.find((t) => t.templateId === id) ?? null;
  }

  function sortLabel(key: string): string {
    return key;
  }

  function prepareForm(event: SubmitEvent): void {
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const mine = data.get("mine") === "true";
    const assigneeValue = (data.get("assignee") as string | null) ?? "";

    // Trim free-text inputs before submission so empty-looking values become
    // empty and the server load does not have to fight leading whitespace.
    for (const name of ["tenant", "createdBy", "session"]) {
      const el = form.elements.namedItem(name) as HTMLInputElement | null;
      if (el) el.value = el.value.trim();
    }

    // Enforce mine/assignee mutual exclusivity on the client before submit.
    if (mine) {
      const el = form.elements.namedItem("assignee") as HTMLSelectElement | null;
      if (el) el.value = "";
    }
    if (assigneeValue) {
      const el = form.elements.namedItem("mine") as HTMLInputElement | null;
      if (el) el.checked = false;
    }
  }
</script>

<form class="filter-bar" method="get" action="?" onsubmit={prepareForm}>
  <label class="filter-field">
    <span>Status</span>
    <select name="status" value={filters.status ?? ""}>
      <option value="">All</option>
      {#each STATUSES as status}
        <option value={status}>{statusLabel(status)}</option>
      {/each}
    </select>
  </label>

  {#if capabilities.assigneesListing}
    <label class="filter-field">
      <span>Assignee</span>
      <select name="assignee" value={filters.assignee ?? ""} disabled={filters.mine}>
        <option value="">Any</option>
        {#each assigneeOptions() as name}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if capabilities.listFiltersSort}
    <label class="filter-field inline">
      <input type="checkbox" name="mine" value="true" checked={filters.mine} />
      <span>Mine ({currentProfile})</span>
    </label>
  {/if}

  {#if capabilities.tenantNamespace}
    <label class="filter-field">
      <span>Tenant</span>
      <input type="text" name="tenant" value={filters.tenant ?? ""} placeholder="tenant" />
    </label>
  {/if}

  {#if capabilities.createdBy}
    <label class="filter-field">
      <span>Created by</span>
      <input type="text" name="createdBy" value={filters.createdBy ?? ""} placeholder="actor" />
    </label>
  {/if}

  {#if capabilities.listFiltersSort}
    <label class="filter-field">
      <span>Session</span>
      <input type="text" name="session" value={filters.session ?? ""} placeholder="session id" />
    </label>
  {/if}

  {#if capabilities.listFiltersSort}
    <label class="filter-field inline">
      <input type="checkbox" name="archived" value="true" checked={filters.archived} />
      <span>Archived</span>
    </label>
  {/if}

  {#if capabilities.listFiltersSort && capabilities.workflowTemplates}
    <label class="filter-field">
      <span>Workflow</span>
      <select name="workflowTemplateId" value={filters.workflowTemplateId ?? ""}>
        <option value="">Any</option>
        {#each templates as template}
          <option value={template.templateId}>{template.name}</option>
        {/each}
      </select>
    </label>

    <label class="filter-field">
      <span>Step</span>
      <select name="stepKey" value={filters.stepKey ?? ""} disabled={!selectedTemplate(filters.workflowTemplateId)}>
        <option value="">Any</option>
        {#each selectedTemplate(filters.workflowTemplateId)?.steps ?? [] as step}
          <option value={step}>{step}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if capabilities.listFiltersSort}
    <label class="filter-field">
      <span>Sort</span>
      <select name="sort" value={filters.sort}>
        {#each VALID_SORT_KEYS as key}
          <option value={key}>{sortLabel(key)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <div class="filter-actions">
    <button type="submit" class="btn">Apply</button>
    <a href="?" class="btn secondary">Reset</a>
  </div>
</form>

<style>
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    background: var(--surface);
    margin-bottom: 16px;
  }
  .filter-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .filter-field.inline {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .filter-field span {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .filter-field input,
  .filter-field select {
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    font-size: 13px;
    color: var(--text);
  }
  .filter-field input:disabled,
  .filter-field select:disabled {
    opacity: 0.45;
    box-shadow: none;
    cursor: not-allowed;
  }
  .filter-actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .btn.secondary {
    background: var(--surface);
    color: var(--text);
  }
</style>

