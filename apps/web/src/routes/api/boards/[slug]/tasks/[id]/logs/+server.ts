import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate } from "$lib/server/bridge";

// KDI-UI-001 scope lists "logs", but no `src/models/*` function returns worker
// log lines as structured data — worker logs are captured to files via
// `getTaskLogPath` in `src/observability.ts` (not a model), gated by
// ff_worker_log_capture. Per the spec's own escape hatch, surface the model gap
// as 501 not_implemented so the UI can feature-detect and the gap is tracked.
// A real logs route belongs to a follow-up backlog item (with
// ff_worker_log_capture); per "the bridge does not write new SQL" we add none
// here. Existence/flag checks are handled by sibling task routes.
//
// ponytail: return the spec's exact 501 shape rather than invent a log reader.
export const GET: RequestHandler = async () => {
  const disabled = gate();
  if (disabled) return disabled;
  return json(
    { error: "not_implemented", reason: "model gap: worker logs have no src/models/* reader" },
    { status: 501 },
  );
};