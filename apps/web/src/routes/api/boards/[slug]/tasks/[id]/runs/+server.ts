import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, taskRunsJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await taskRunsJson(event.params.slug, Number(event.params.id), event.url.searchParams));
  } catch (e) {
    return errorResponse(e);
  }
};