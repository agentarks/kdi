import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, listTasksJson, createTaskJson, type CreateTaskBody } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await listTasksJson(event.params.slug, event.url.searchParams));
  } catch (e) {
    return errorResponse(e);
  }
};

export const POST: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    const body = (await event.request.json()) as CreateTaskBody;
    return json(await createTaskJson(event.params.slug, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
};