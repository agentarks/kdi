// KDI-UI-009 Slice 1: /stats page data resolver. Extracted out of the
// +page.server.ts load function so it is unit-testable under `bun test` (the
// route file's `./$types` import cannot be resolved outside SvelteKit/Vite, so
// the testable logic lives here and the loader is a thin wrapper).
//
// Imports ONLY from the bridge — never bun:sqlite or ~/models/* — so the
// "SQLite stays server-side" guard in bridge.test.ts stays green. Types are
// derived from the bridge return shapes rather than imported model interfaces.
import {
  showBoardJson,
  readCurrentBoardJson,
  boardStatsJson,
  statsFlags,
  BridgeError,
} from "./bridge";
import type { StatsFlags } from "$lib/types";

export type StatsStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "done"
  | "blocked"
  | "review";

// The 8 status buckets the model actually returns (getBoardStats excludes
// archived via `archived_at IS NULL`). Order is the BRD FR-4 display order.
// ponytail: model is the source of truth — rendering a 9th fake `archived:0`
// would diverge from `kdi stats --json` and break AC-03 parity.
export const STATS_STATUSES: readonly StatsStatus[] = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "done",
  "blocked",
  "review",
];

// Derive the camelCase shapes the bridge already normalizes, without importing
// the snake_case model interfaces (which would trip the server-side guard).
type StatsBoard = Awaited<ReturnType<typeof showBoardJson>>["board"];
type StatsPayload = Awaited<ReturnType<typeof boardStatsJson>>["stats"];

export interface StatsPageData {
  enabled: boolean;
  flags: StatsFlags;
  boardSlug: string;
  board?: StatsBoard;
  stats?: StatsPayload;
  statuses?: readonly StatsStatus[];
  snapshotAt?: number;
  error?: string;
}

// Resolve the /stats payload for a request URL. Board resolution mirrors
// activity/+page.server.ts (?board -> readCurrentBoard -> "default"). FF_STATS
// off -> disabled payload (FR-2 / AC-11). Missing/archived board -> inline
// error (FR-1).
export async function loadStatsPage(url: URL): Promise<StatsPageData> {
  const flags = statsFlags();
  const boardSlug =
    url.searchParams.get("board") ?? (await readCurrentBoardJson()) ?? "default";

  if (!flags.stats) {
    return { enabled: false, flags, boardSlug };
  }

  try {
    const { board } = await showBoardJson(boardSlug, false);
    const { stats } = await boardStatsJson(boardSlug);
    return {
      enabled: true,
      flags,
      boardSlug,
      board,
      stats,
      statuses: STATS_STATUSES,
      snapshotAt: Date.now(),
    };
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { enabled: true, flags, boardSlug, error: err.message };
    }
    throw err;
  }
}
