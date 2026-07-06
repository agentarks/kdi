import { fail, redirect } from "@sveltejs/kit";
import { isEnabled, FF_BOARD_METADATA, FF_BOARD_CREATE_SWITCH } from "~/flags";
import { createBoardJson, switchBoardJson, boardUiFlags, bridgeError } from "$lib/server/bridge";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async () => {
  return { flags: boardUiFlags() };
};

const LABELS: Record<string, string> = {
  name: "Name",
  icon: "Icon",
  color: "Color",
  description: "Description",
};

function valuesFromForm(data: FormData): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of data.entries()) {
    values[key] = value;
  }
  return values;
}

export const actions: Actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    const values = valuesFromForm(data);
    const slug = data.get("slug")?.toString().trim() ?? "";
    const workdir = data.get("workdir")?.toString().trim() ?? "";
    const baseRef = data.get("baseRef")?.toString().trim() || "origin/main";
    const switchCurrent = data.get("switch") === "on";

    const metadata: Record<string, string> = {};
    for (const key of ["name", "icon", "color", "description"] as const) {
      const raw = data.get(key)?.toString();
      if (raw === undefined) continue;
      if (raw.trim() === "") {
        if (raw.length > 0) {
          return fail(400, { error: `${LABELS[key]} cannot be empty.`, values });
        }
        continue;
      }
      metadata[key] = raw.trim();
    }

    if (!isEnabled(FF_BOARD_METADATA) && Object.keys(metadata).length > 0) {
      return fail(400, { error: "Board metadata feature is not enabled.", values });
    }
    if (switchCurrent && !isEnabled(FF_BOARD_CREATE_SWITCH)) {
      return fail(400, { error: "Board create --switch feature is not enabled.", values });
    }

    try {
      await createBoardJson({ slug, workdir, baseRef, metadata });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { error: be.message, values });
    }

    if (switchCurrent) {
      try {
        await switchBoardJson(slug);
      } catch (err) {
        const be = bridgeError(err);
        return fail(be.status, { error: be.message, values });
      }
    }

    redirect(303, `/boards?success=${encodeURIComponent("Board created")}`);
  },
};
