import { error, fail, redirect } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
  showBoardJson,
  showTaskJson,
  isSvelteKitEnabled,
  editTaskJson,
  BridgeError,
} from "$lib/server/bridge";

export const load: PageServerLoad = async ({ params }) => {
  if (!isSvelteKitEnabled()) {
    throw error(404, "UI disabled");
  }
  const { board } = await showBoardJson(params.slug);
  let task;
  try {
    ({ task } = await showTaskJson(params.slug, Number(params.id)));
  } catch (err) {
    if (err instanceof BridgeError && err.code === "task_not_found") {
      throw error(404, `Task ${params.id} not found.`);
    }
    throw err;
  }
  return { board, task, flags: { sveltekitFrontend: isSvelteKitEnabled() } };
};

export const actions: Actions = {
  default: async ({ request, params }) => {
    if (!isSvelteKitEnabled()) {
      throw error(404, "UI disabled");
    }

    const data = await request.formData();
    const body = data.get("body")?.toString().trim() ?? "";

    try {
      await editTaskJson(params.slug, Number(params.id), body);
      throw redirect(303, `/boards/${params.slug}/tasks/${params.id}`);
    } catch (err) {
      if (err instanceof BridgeError) {
        return fail(400, { error: err.message, body });
      }
      throw err;
    }
  },
};
