// KDI-UI-009 Slice 2 — /diagnostics read-only loader.
//
// Board resolution mirrors activity/+page.server.ts (?board → current → default).
// Gap 1: gates on FF_DIAGNOSTICS (the bridge does NOT enforce this sub-flag).
// Gap 2: severity validation lives HERE (not in the bridge/model), matching
// src/commands/diagnostics.ts exactly — normalize lowercase for the check,
// echo the ORIGINAL value in the rejection message.
// FR-15: ?task=<id> URL param → bridge `taskId` param.
// Read-only: no POST/mutation wiring — action shortcuts are Slice 3.

import type { PageServerLoad } from "./$types";
import {
  showBoardJson,
  readCurrentBoardJson,
  diagnosticsJson,
  diagnosticsFlags,
  BridgeError,
} from "$lib/server/bridge";

const VALID_SEVERITIES = ["warning", "error", "critical"];

export const load: PageServerLoad = async ({ url }) => {
  const flags = diagnosticsFlags();

  // Gap 1: FF_DIAGNOSTICS gate. Disabled payload when the sub-flag is off —
  // the bridge's diagnosticsJson() runs regardless of this flag.
  if (!flags.diagnostics) {
    return { flags };
  }

  // Gap 2: validate severity BEFORE board resolution so an invalid value is
  // rejected regardless of board state (matches CLI: validate, then resolve).
  const rawSeverity = url.searchParams.get("severity");
  let severity: string | undefined;
  if (rawSeverity !== null) {
    const normalized = rawSeverity.toLowerCase();
    if (!VALID_SEVERITIES.includes(normalized)) {
      return {
        error: `Invalid severity "${rawSeverity}". Valid: warning, error, critical`,
        flags,
      };
    }
    severity = normalized;
  }

  const slug = url.searchParams.get("board") ?? (await readCurrentBoardJson());
  if (!slug) {
    return { error: "No board selected.", flags };
  }

  // Resolve the board (validates existence + archived) for the header name.
  let boardResult: Awaited<ReturnType<typeof showBoardJson>>;
  try {
    boardResult = await showBoardJson(slug, false);
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags };
    }
    throw err;
  }
  const board = boardResult.board;

  // FR-15: ?task= URL param → bridge `taskId` param.
  const rawTask = url.searchParams.get("task");
  const taskId = rawTask !== null ? Number(rawTask) : undefined;
  const params = new URLSearchParams();
  if (severity) params.set("severity", severity);
  if (taskId !== undefined) params.set("taskId", String(taskId));

  try {
    const { diagnostics } = await diagnosticsJson(slug, params);
    return { board, findings: diagnostics, flags, severity: rawSeverity ?? "", taskId };
  } catch (err) {
    // 404 task_not_found → inline error (do not crash the page).
    if (err instanceof BridgeError && err.code === "task_not_found") {
      return { error: err.message, flags, board };
    }
    throw err;
  }
};
