<script lang="ts">
  import type { KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";
  import { STATUSES, VALID_SORT_KEYS } from "$lib/kanban";

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

  function selectedTemplate(): KanbanTemplate | null {
    return templates.find((t) => t.templateId === filters.workflowTemplateId) ?? null;
  }

  function statusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  function sortLabel(key: string): string {
    return key;
  }
</script>

<form class="filter-bar" method="get" action="?">
  <label class="filter-field">
    <span>Status</span>
    <select name="status" value={filters.status ?? ""}>
      <option value="">All</option>
      {#each STATUSES as status}
        <option value={status}>{statusLabel(status)}</option>
      {/each}
    </select>
  </label>

  <label class="filter-field">
    <span>Assignee</span>
    <select name="assignee" value={filters.assignee ?? ""} disabled={filters.mine}>
      <option value="">Any</option>
      {#each assigneeOptions() as name}
        <option value={name}>{name}</option>
      {/each}
    </select>
  </label>

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
      <input type="text" name="sessionId" value={filters.sessionId ?? ""} placeholder="session id" />
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
      <select name="stepKey" value={filters.stepKey ?? ""} disabled={!selectedTemplate()}>
        <option value="">Any</option>
        {#each selectedTemplate()?.steps ?? [] as step}
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
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 0.5rem;
    background: var(--color-surface, #f9fafb);
  }
  .filter-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .filter-field.inline {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .filter-field span {
    font-size: 0.75rem;
    color: var(--color-dim, #6b7280);
  }
  .filter-field input,
  .filter-field select {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 0.25rem;
    background: white;
    font-size: 0.85rem;
  }
  .filter-actions {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }
  .btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 0.25rem;
    background: var(--color-primary, #2563eb);
    color: white;
    font-size: 0.85rem;
    text-decoration: none;
    cursor: pointer;
  }
  .btn.secondary {
    background: white;
    color: var(--color-text, #111827);
  }
</style>
