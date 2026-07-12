// KDI-UI-006 review finding #4: malformed JSON must map to a stable 400, not a
// 500. The apiPost factory is the single place every POST route parses its body,
// so the guard lives there and is tested here directly.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { apiPost } from "./handler";
import { clearOverrides } from "~/flags";

const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["FF_SVELTEKIT_FRONTEND"]) {
    envSnapshot[k] = process.env[k];
    process.env[k] = k === "FF_SVELTEKIT_FRONTEND" ? "true" : process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearOverrides();
});

// Build a minimal RequestEvent stub. The malformed-JSON path never reaches `fn`,
// so only `request` needs to be real; cast keeps the test free of plumbing.
function eventWith(body: string, contentType = "application/json") {
  return {
    request: new Request("http://localhost/x", { method: "POST", body, headers: { "content-type": contentType } }),
  } as unknown as Parameters<ReturnType<typeof apiPost>>[0];
}

describe("apiPost malformed-JSON handling (review finding #4)", () => {
  it("returns 400 invalid_json for malformed JSON body", async () => {
    const handler = apiPost(async () => ({ ok: true }));
    const res = await handler(eventWith("{not json"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_json");
    expect(typeof data.message).toBe("string");
  });

  it("returns 400 invalid_json for empty body", async () => {
    const handler = apiPost(async () => ({ ok: true }));
    const res = await handler(eventWith(""));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("still invokes fn for valid JSON", async () => {
    let received: unknown = null;
    const handler = apiPost(async (_e, body: unknown) => {
      received = body;
      return { created: true };
    });
    const res = await handler(eventWith(JSON.stringify({ x: 1 })));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true });
    expect(received).toEqual({ x: 1 });
  });
});
