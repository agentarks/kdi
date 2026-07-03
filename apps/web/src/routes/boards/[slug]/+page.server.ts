import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {
  showBoardJson,
  listTasksJson,
  assigneesJson,
  listProfilesJson,
  workflowsJson,
  resolveCurrentProfile,
} from "$lib/server/bridge";
import { isEnabled, FF_LIST_FILTERS_SORT, FF_TENANT_NAMESPACE, FF_CREATED_BY, FF_ASSIGNEES_LISTING, FF_WORKFLOW_TEMPLATES, FF_RATE_LIMIT_EXIT_CODE, FF_HEARTBEAT } from "~/flags";
import type { KanbanTask, KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";

export const load: PageServerLoad = async ({ params, url }) => {
  const slug = params.slug;
  const search = url.searchParams;

  let board: Awaited<ReturnType<typeof showBoardJson>>["board"];
  try {
    const result = await showBoardJson(slug);
    board = result.board;
  } catch (err) {
    error(404, err instanceof Error ? err.message : "Board not found");
    return;
  }

  const capabilities: KanbanCapabilities = {
    listFiltersSort: isEnabled(FF_LIST_FILTERS_SORT),
    tenantNamespace: isEnabled(FF_TENANT_NAMESPACE),
    createdBy: isEnabled(FF_CREATED_BY),
    assigneesListing: isEnabled(FF_ASSIGNEES_LISTING),
    workflowTemplates: isEnabled(FF_WORKFLOW_TEMPLATES),
    rateLimitExitCode: isEnabled(FF_RATE_LIMIT_EXIT_CODE),
    heartbeat: isEnabled(FF_HEARTBEAT),
  };

  const filters: KanbanFilterState = {
    status: search.get("status"),
    assignee: search.get("assignee"),
    mine: search.get("mine") === "true",
    tenant: search.get("tenant")?.trim() || null,
    createdBy: search.get("createdBy")?.trim() || null,
    session: search.get("session")?.trim() || null,
    archived: search.get("archived") === "true",
    workflowTemplateId: search.get("workflowTemplateId"),
    stepKey: search.get("stepKey"),
    sort: search.get("sort") || "created-desc",
  };

  if (filters.status === "archived" && !filters.archived) {
    filters.archived = true;
  }

  let tasks: KanbanTask[] = [];
  let assignees: Record<string, number> = {};
  let profiles: string[] = [];
  let templates: KanbanTemplate[] = [];

  try {
    const query = new URLSearchParams();
    if (filters.status) query.set("status", filters.status);
    if (filters.assignee) query.set("assignee", filters.assignee);
    if (filters.mine) query.set("mine", "true");
    if (filters.tenant) query.set("tenant", filters.tenant);
    if (filters.createdBy) query.set("createdBy", filters.createdBy);
    if (filters.session) query.set("session", filters.session);
    if (filters.archived) query.set("archived", "true");
    if (filters.workflowTemplateId) query.set("workflowTemplateId", filters.workflowTemplateId);
    if (filters.stepKey) query.set("stepKey", filters.stepKey);
    if (filters.sort) query.set("sort", filters.sort);

    const [tasksResult, assigneesResult, profilesResult, templatesResult] = await Promise.all([
      listTasksJson(slug, query),
      assigneesJson(slug),
      listProfilesJson(),
      capabilities.workflowTemplates ? workflowsJson(slug) : Promise.resolve({ templates: [] }),
    ]);
    tasks = tasksResult.tasks;
    assignees = assigneesResult.assignees;
    profiles = profilesResult.profiles;
    templates = templatesResult.templates;
  } catch (err) {
    error(400, err instanceof Error ? err.message : String(err));
    return;
  }

  return {
    board,
    tasks,
    filters,
    assignees,
    profiles,
    templates,
    currentProfile: resolveCurrentProfile(),
    capabilities,
  };
};
