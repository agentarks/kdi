import { apiGet, apiPost } from "$lib/server/handler";
import { taskCommentsJson, postCommentJson, type PostCommentInput } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => taskCommentsJson(e.params.slug, Number(e.params.id)));
export const POST: RequestHandler = apiPost((e, body: PostCommentInput) => postCommentJson(e.params.slug, Number(e.params.id), body), 201);
