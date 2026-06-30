import { fail } from "@sveltejs/kit";
import { initDb } from "~/db";
import type { Actions, PageServerLoad } from "./$types";
import { applyTaskAction, loadTaskDetail } from "$lib/server/taskActions";
import { isEnabled, FF_SCHEDULED_STATUS, FF_REVIEW_STATUS, FF_COMPLETE_METADATA, FF_ASSIGN_REASSIGN, FF_HEARTBEAT } from "~/flags";

export const load: PageServerLoad = async ({ params }) => {
  if (process.env.FF_SVELTEKIT_FRONTEND !== "true") {
    return { enabled: false };
  }
  initDb();
  const id = Number(params.id);
  const { task, board } = loadTaskDetail(id);
  return {
    enabled: true,
    task,
    board,
    capabilities: {
      scheduled: isEnabled(FF_SCHEDULED_STATUS),
      review: isEnabled(FF_REVIEW_STATUS),
      completeMetadata: isEnabled(FF_COMPLETE_METADATA),
      assignReassign: isEnabled(FF_ASSIGN_REASSIGN),
      heartbeat: isEnabled(FF_HEARTBEAT),
    },
  };
};

export const actions: Actions = {
  default: async ({ request, params }) => {
    if (process.env.FF_SVELTEKIT_FRONTEND !== "true") {
      return fail(403, { error: "SvelteKit UI is disabled." });
    }
    initDb();

    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "");
    if (!action) {
      return fail(400, { error: "Missing _action field." });
    }

    const id = Number(params.id);
    if (Number.isNaN(id) || id <= 0) {
      return fail(400, { error: "Invalid task ID." });
    }

    const result = applyTaskAction(action, id, formData);
    return { action, result };
  },
};
