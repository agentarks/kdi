import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  gate,
  errorResponse,
  listBoardsJson,
  createBoardJson,
  type CreateBoardInput,
} from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await listBoardsJson(event.url.searchParams));
  } catch (e) {
    return errorResponse(e);
  }
};

export const POST: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    const body = (await event.request.json()) as CreateBoardInput;
    return json(await createBoardJson(body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
};