// KDI-UI-001 route boilerplate killer. Every /api/+server.ts handler repeats
// the same gate -> try/catch -> json dance; these factories do it once so each
// route collapses to one line. ponytail: one factory for 16 callers, not a
// factory for one impl. bridge.ts itself stays SvelteKit-free (unit-tested under
// `bun test`); the SvelteKit coupling lives here.
//
// `Params` is generic so each route's generated `RequestHandler` from `./$types`
// (e.g. `RequestHandler<{ slug: string }>`) drives `event.params` to concrete
// `string` values instead of the default `string | undefined`. Routes must keep
// the `export const GET: RequestHandler = apiGet(...)` annotation from `./$types`.

import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { gate, errorResponse } from "./bridge";

// GET-style: call fn(event), json() the result. If fn returns a Response (e.g.
// the logs 501), pass it through untouched.
export function apiGet<
  Params extends Record<string, string> = Record<string, string>,
  T = unknown,
>(fn: (event: RequestEvent<Params>) => Promise<T>): RequestHandler<Params> {
  return async (event) => {
    const disabled = gate();
    if (disabled) return disabled;
    try {
      const result = await fn(event);
      return result instanceof Response ? result : json(result);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// POST-style: parse the request body as B, call fn(event, body), json() with
// status (default 201 for create routes).
export function apiPost<
  Params extends Record<string, string> = Record<string, string>,
  B = unknown,
  T = unknown,
>(fn: (event: RequestEvent<Params>, body: B) => Promise<T>, status = 201): RequestHandler<Params> {
  return async (event) => {
    const disabled = gate();
    if (disabled) return disabled;
    try {
      // Malformed/missing JSON is a client error, not a 500. Caught here so every
      // POST route (16+ callers) returns a stable 400 instead of leaking a parse
      // error through the generic 500 path. ponytail: one guard in the factory.
      let body: B;
      try {
        body = (await event.request.json()) as B;
      } catch {
        return json(
          { error: "invalid_json", message: "Request body must be valid JSON." },
          { status: 400 },
        );
      }
      return json(await fn(event, body), { status });
    } catch (e) {
      return errorResponse(e);
    }
  };
}