import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, diagnosticsJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await diagnosticsJson(event.params.slug, event.url.searchParams));
  } catch (e) {
    return errorResponse(e);
  }
};