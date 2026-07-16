// KDI-UI-013 Slice 1: /boards/[slug]/workflows — list + define/upsert.
// Board-scoped route (not a top-level nav item); linked from the board view.
// The define action is a SvelteKit form action (matches KDI-UI-002/004), not a
// new /api route. SQLite stays server-side via the bridge (FR-29).

import { fail, redirect } from "@sveltejs/kit";
import { isEnabled, FF_WORKFLOW_TEMPLATES } from "~/flags";
import {
  showBoardJson,
  workflowsJson,
  defineWorkflowTemplateJson,
  BridgeError,
  bridgeError,
} from "$lib/server/bridge";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const flags = { workflowTemplates: isEnabled(FF_WORKFLOW_TEMPLATES) };
  try {
    const { board } = await showBoardJson(params.slug, false);
    const { templates } = await workflowsJson(params.slug);
    return { board, templates, flags };
  } catch (err) {
    // FR-1: a missing/archived board renders an inline error (no form).
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags };
    }
    throw err;
  }
};

// FR-9: parse the steps textarea by splitting on newlines, trimming, and
// dropping empty lines. The model performs the final validation (non-empty,
// ≤100, ≤255 chars per key, no duplicates) and throws the exact CLI strings.
function parseSteps(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export const actions: Actions = {
  // FR-7..FR-13: define / upsert a workflow template.
  define: async ({ request, params }) => {
    // FR-27: every server action re-checks the flag; client gating is UX only.
    if (!isEnabled(FF_WORKFLOW_TEMPLATES)) {
      return fail(403, { error: "Workflow templates feature is not enabled." });
    }
    const data = await request.formData();
    const rawValues = {
      template_id: data.get("template_id")?.toString() ?? "",
      name: data.get("name")?.toString() ?? "",
      steps: data.get("steps")?.toString() ?? "",
    };
    try {
      await defineWorkflowTemplateJson(params.slug, {
        templateId: rawValues.template_id,
        name: rawValues.name,
        steps: parseSteps(rawValues.steps),
      });
    } catch (err) {
      const be = bridgeError(err);
      return fail(be.status, { error: be.message, values: rawValues });
    }
    // FR-13: reload with the updated list and the define form cleared.
    redirect(303, `/boards/${params.slug}/workflows?success=${encodeURIComponent("Template saved")}`);
  },
};