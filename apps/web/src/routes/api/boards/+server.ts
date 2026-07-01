import { apiGet, apiPost } from "$lib/server/handler";
import { listBoardsJson, createBoardJson, type CreateBoardInput } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => listBoardsJson(e.url.searchParams));
export const POST: RequestHandler = apiPost((_e, body: CreateBoardInput) => createBoardJson(body));