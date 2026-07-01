import { json } from "@sveltejs/kit";
import { apiGet } from "$lib/server/handler";
import type { RequestHandler } from "./$types";

// KDI-UI-001 scope lists "logs", but no `src/models/*` function returns worker
// log lines as structured data — worker logs are captured to files via
// `getTaskLogPath` in `src/observability.ts` (not a model), gated by
// ff_worker_log_capture. Per the spec's own escape hatch, surface the model gap
// as 501 not_implemented so the UI can feature-detect and the gap is tracked.
// A real logs route belongs to a follow-up backlog item (with
// ff_worker_log_capture); per "the bridge does not write new SQL" we add none.
//
// ponytail: return the spec's exact 501 shape rather than invent a log reader.
// apiGet passes a Response through untouched (it only json()-wraps plain data).
export const GET: RequestHandler = apiGet(() =>
  Promise.resolve(
    json(
      { error: "not_implemented", reason: "model gap: worker logs have no src/models/* reader" },
      { status: 501 },
    ),
  ),
);