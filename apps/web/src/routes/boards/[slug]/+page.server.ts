import { fail, redirect } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
  showBoardJson,
  listTasksJson,
  assigneesJson,
  listProfilesJson,
  workflowsJson,
  resolveCurrentProfile,
  boardUiFlags,
  readCurrentBoardJson,
  switchBoardJson,
  archiveBoardJson,
  renameBoardJson,
  renameBoardSlugJson,
  removeBoardJson,
  lifecycleFlags,
  BridgeError,
  bridgeError,
} from "$lib/server/bridge";
import {
  isEnabled,
  FF_LIST_FILTERS_SORT,
  FF_TENANT_NAMESPACE,
  FF_CREATED_BY,
  FF_ASSIGNEES_LISTING,
  FF_WORKFLOW_TEMPLATES,
  FF_RATE_LIMIT_EXIT_CODE,
  FF_HEARTBEAT,
  FF_BULK_OPERATIONS,
  FF_BOARD_SWITCH,
  FF_BOARD_RENAME_HERMES,
  FF_BOARD_RENAME,
  FF_BOARD_RM_DELETE,
} from "~/flags";
import type { KanbanTask, KanbanFilterState, KanbanCapabilities, KanbanTemplate } from "$lib/kanban";

export const load: PageServerLoad = async ({ params, url }) => {
  const slug = params.slug;
  const search = url.searchParams;

  let board: Awaited<ReturnType<typeof showBoardJson>>["board"];
  let currentSlug: string | null;
  let flags: ReturnType<typeof boardUiFlags>;
  try {
    const boardResult = await showBoardJson(slug, true);
    board = boardResult.board;
    currentSlug = await readCurrentBoardJson();
    flags = boardUiFlags();
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags: boardUiFlags() };
    }
    throw err;
  }

  const capabilities: KanbanCapabilities = {
    listFiltersSort: isEnabled(FF_LIST_FILTERS_SORT),
    tenantNamespace: isEnabled(FF_TENANT_NAMESPACE),
    createdBy: isEnabled(FF_CREATED_BY),
    assigneesListing: isEnabled(FF_ASSIGNEES_LISTING),
    workflowTemplates: isEnabled(FF_WORKFLOW_TEMPLATES),
    rateLimitExitCode: isEnabled(FF_RATE_LIMIT_EXIT_CODE),
    heartbeat: isEnabled(FF_HEARTBEAT),
    bulkOperations: isEnabled(FF_BULK_OPERATIONS),
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

  const basePayload = {
    board,
    currentSlug,
    flags,
    lifecycle: lifecycleFlags(),
    filters,
    currentProfile: resolveCurrentProfile(),
    capabilities,
  };

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
      capabilities.workflowTemplates ? workflowsJson(slug) : Promise.resolve({ templates: [] as KanbanTemplate[] }),
    ]);

    return {
      ...basePayload,
      tasks: tasksResult.tasks,
      assignees: assigneesResult.assignees,
      profiles: profilesResult.profiles,
      templates: templatesResult.templates,
    };
  } catch (err) {
    // Surface bridge errors inline; the page shows the error and still renders
    // the board shell so the operator is not stranded.
    return {
      ...basePayload,
      error: err instanceof Error ? err.message : String(err),
      tasks: [] as KanbanTask[],
      assignees: {},
      profiles: [],
      templates: [],
    };
  }
};

export const actions: Actions = {
  switch: async ({ params }) => {
    if (!isEnabled(FF_BOARD_SWITCH)) {
      return fail(403, {
        intent: "switch",
        slug: params.slug,
        error: "Board switch feature is not enabled.",
      });
    }
    try {
      await switchBoardJson(params.slug);
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { intent: "switch", slug: params.slug, error: be.message });
    }
    redirect(303, `/boards?success=${encodeURIComponent("Switched current board")}`);
  },

  archive: async ({ request, params }) => {
    const data = await request.formData();
    if (data.get("confirm") !== "true") {
      return fail(400, {
        intent: "archive",
        slug: params.slug,
        error: "Confirmation required.",
      });
    }
    try {
      await archiveBoardJson(params.slug);
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { intent: "archive", slug: params.slug, error: be.message });
    }
    redirect(303, `/boards?success=${encodeURIComponent("Board archived")}`);
  },

  rename: async ({ request, params }) => {
    if (!isEnabled(FF_BOARD_RENAME_HERMES)) {
      return fail(403, {
        intent: "rename",
        slug: params.slug,
        error: "Board rename (Hermes semantics) feature is not enabled.",
      });
    }
    const data = await request.formData();
    const name = data.get("name")?.toString().trim() ?? "";
    if (name === "") {
      return fail(400, {
        intent: "rename",
        slug: params.slug,
        error: "Name cannot be empty.",
        values: { name },
      });
    }
    try {
      await renameBoardJson({ slug: params.slug, name });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { intent: "rename", slug: params.slug, error: be.message, values: { name } });
    }
    redirect(303, `/boards?success=${encodeURIComponent("Board renamed")}`);
  },

  renameSlug: async ({ request, params }) => {
    if (!isEnabled(FF_BOARD_RENAME)) {
      return fail(403, {
        intent: "renameSlug",
        slug: params.slug,
        error: "Board rename feature is not enabled.",
      });
    }
    const data = await request.formData();
    const newSlug = data.get("newSlug")?.toString().trim() ?? "";
    try {
      await renameBoardSlugJson({ oldSlug: params.slug, newSlug });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, {
        intent: "renameSlug",
        slug: params.slug,
        error: be.message,
        values: { newSlug },
      });
    }
    redirect(303, `/boards/${newSlug}?success=${encodeURIComponent("Board slug renamed")}`);
  },

  delete: async ({ request, params }) => {
    if (!isEnabled(FF_BOARD_RM_DELETE)) {
      return fail(403, {
        intent: "delete",
        slug: params.slug,
        error: "Board hard-delete is not enabled. Set FF_BOARD_RM_DELETE=true to use delete.",
      });
    }
    const data = await request.formData();
    const confirmedSlug = data.get("confirmedSlug")?.toString().trim() ?? "";
    if (confirmedSlug !== params.slug) {
      return fail(400, {
        intent: "delete",
        slug: params.slug,
        error: `Confirmed slug does not match "${params.slug}".`,
        values: { confirmedSlug },
      });
    }
    try {
      await removeBoardJson(params.slug);
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { intent: "delete", slug: params.slug, error: be.message });
    }
    redirect(303, `/boards?success=${encodeURIComponent("Board deleted")}`);
  },
};
