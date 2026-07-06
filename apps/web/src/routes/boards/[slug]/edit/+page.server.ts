import { fail, redirect } from "@sveltejs/kit";
import { isEnabled, FF_BOARD_METADATA, FF_DEFAULT_WORKDIR } from "~/flags";
import {
  showBoardJson,
  boardUiFlags,
  updateBoardMetadataJson,
  setDefaultWorkdirJson,
  BridgeError,
  bridgeError,
} from "$lib/server/bridge";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  try {
    const { board } = await showBoardJson(params.slug, false);
    return { board, flags: boardUiFlags() };
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags: boardUiFlags() };
    }
    throw err;
  }
};

export const actions: Actions = {
  metadata: async ({ request, params }) => {
    if (!isEnabled(FF_BOARD_METADATA)) {
      return fail(403, { error: "Board metadata feature is not enabled." });
    }
    const data = await request.formData();
    const rawValues = {
      name: data.get("name")?.toString() ?? "",
      icon: data.get("icon")?.toString() ?? "",
      color: data.get("color")?.toString() ?? "",
      description: data.get("description")?.toString() ?? "",
    };
    const metadataInput: { name?: string; icon?: string; color?: string; description?: string } = {};
    for (const key of ["name", "icon", "color", "description"] as const) {
      const raw = rawValues[key];
      if (raw.trim() === "") continue;
      metadataInput[key] = raw;
    }
    try {
      await updateBoardMetadataJson({ slug: params.slug, ...metadataInput });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { error: be.message, values: rawValues });
    }
    redirect(303, `/boards/${params.slug}?success=${encodeURIComponent("Board updated")}`);
  },

  defaultWorkdir: async ({ request, params }) => {
    if (!isEnabled(FF_DEFAULT_WORKDIR)) {
      return fail(403, { error: "Default workdir feature is not enabled." });
    }
    const data = await request.formData();
    const raw = data.get("workdir")?.toString() ?? "";
    if (raw.trim() === "" && raw.length > 0) {
      return fail(400, {
        error: "Default workdir cannot be empty. Omit the path to clear it.",
        values: { workdir: raw },
      });
    }
    const workdir = raw.trim() === "" ? null : raw.trim();
    try {
      await setDefaultWorkdirJson({ slug: params.slug, workdir });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { error: be.message, values: { workdir: raw } });
    }
    redirect(303, `/boards/${params.slug}?success=${encodeURIComponent("Default workdir updated")}`);
  },
};
