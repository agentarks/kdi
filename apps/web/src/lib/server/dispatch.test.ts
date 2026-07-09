import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBoardJson,
  createTaskJson,
  dispatchStatusJson,
  dispatchOnceJson,
  bootstrapProfilesJson,
  BridgeError,
} from "./bridge";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";

let tmpHome: string;
const tmpDirs: string[] = [];

function isolate(): void {
  tmpHome = `/tmp/kdi-ui007-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_ENABLE_KANBAN_DISPATCH = "true";
  process.env.FF_DISPATCH_ONCE = "true";
  process.env.FF_DISPATCH_CONTROLS = "true";
  process.env.FF_RATE_LIMIT_EXIT_CODE = "true";
  process.env.FF_REAL_HARNESS_PROFILES = "true";
}

function cleanup(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
}

async function expectBridgeError(
  p: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    if (!(e instanceof BridgeError))
      throw new Error(`expected BridgeError, got ${e && (e as Error).name}`);
    expect((e as BridgeError).code).toBe(code);
    expect((e as BridgeError).status).toBe(status);
  }
  if (!threw) throw new Error(`expected promise to reject with ${code}/${status}, but it resolved`);
}

function writeProfiles(command: string): string {
  const profilesDir = join(tmpHome, ".config", "kdi");
  mkdirSync(profilesDir, { recursive: true });
  const profilesPath = join(profilesDir, "profiles.yaml");
  writeFileSync(profilesPath, `- name: opencode\n  command: "${command}"\n- name: pi\n  command: "${command}"\n`);
  process.env.KDI_PROFILES_PATH = profilesPath;
  return profilesPath;
}

beforeEach(() => {
  isolate();
  clearOverrides();
});

afterEach(() => {
  clearOverrides();
  closeDb();
  cleanup();
});

afterAll(() => {
  cleanup();
});

describe("KDI-UI-007 dispatch control center bridge", () => {
  it("dispatchStatusJson returns the expected status shape and flags", async () => {
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    await createTaskJson("dispatch", { title: "Task 1", assignee: "opencode" });

    const status = await dispatchStatusJson("dispatch");
    expect(status.board).toBe("dispatch");
    expect(status.presence.present).toBe(false);
    expect(status.presence.pid).toBeNull();
    expect(status.presence.checkedAt).toBeGreaterThan(0);
    expect(status.taskCounts.ready).toBe(0);
    expect(status.taskCounts.todo).toBe(1);
    expect(status.profiles.enabled).toBe(true);
    expect(status.profiles.entries.length).toBeGreaterThan(0);
    expect(status.recentFailures.enabled).toBe(true);
    expect(status.recentFailures.failures).toEqual([]);
    expect(status.flags.canDispatch).toBe(true);
    expect(status.flags.canUseFailureLimit).toBe(true);
    expect(status.flags.canUseRateLimitCooldown).toBe(true);
    expect(status.flags.canShowProfiles).toBe(true);
  });

  it("dispatchStatusJson returns 404 for missing board", async () => {
    await expectBridgeError(dispatchStatusJson("missing"), "board_not_found", 404);
  });

  it("dispatchOnceJson returns full breakdown when task is blocked after failed worktree", async () => {
    writeProfiles("true");

    await createBoardJson({ slug: "dispatch", workdir: join(tmpHome, "nonexistent") });
    await createTaskJson("dispatch", {
      title: "Ready task",
      assignee: "opencode",
      initialStatus: "ready",
    });

    const status = await dispatchStatusJson("dispatch");
    expect(status.taskCounts.ready).toBe(1);

    const result = await dispatchOnceJson("dispatch", { max: 0 });
    expect(result.processed).toBe(2);
    expect(result.spawned).toBe(1);
    expect(result.blocked).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);

    const updated = await dispatchStatusJson("dispatch");
    expect(updated.taskCounts.ready).toBe(0);
    expect(updated.taskCounts.blocked).toBe(1);
  });

  it("dispatchOnceJson skips tasks when profile binary is missing", async () => {
    writeProfiles("this-binary-does-not-exist");

    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    await createTaskJson("dispatch", {
      title: "Ready task",
      assignee: "opencode",
      initialStatus: "ready",
    });

    const result = await dispatchOnceJson("dispatch", { max: 0 });
    expect(result.processed).toBe(0);
    expect(result.spawned).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("rejects dispatch when feature flags are disabled", async () => {
    process.env.FF_ENABLE_KANBAN_DISPATCH = "false";
    clearOverrides();
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    await expectBridgeError(dispatchOnceJson("dispatch", { max: 0 }), "feature_disabled", 403);
  });

  it("validates max and failureLimit", async () => {
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    await expectBridgeError(dispatchOnceJson("dispatch", { max: -1 }), "invalid_max", 400);
    await expectBridgeError(
      dispatchOnceJson("dispatch", { max: 0, failureLimit: 0 }),
      "invalid_failure_limit",
      400,
    );
  });

  it("validates rateLimitCooldown", async () => {
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    await expectBridgeError(
      dispatchOnceJson("dispatch", { max: 0, rateLimitCooldown: "bad" }),
      "invalid_duration",
      400,
    );
  });

  it("returns dispatch_failed when tick throws", async () => {
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    mock.module("~/dispatcher", () => ({
      tick: () => {
        throw new Error("forced tick failure");
      },
    }));
    try {
      await expectBridgeError(dispatchOnceJson("dispatch", { max: 0 }), "dispatch_failed", 500);
    } finally {
      mock.restore();
    }
  });

  it("bootstrapProfilesJson refreshes profile health list", async () => {
    await createBoardJson({ slug: "dispatch", workdir: tmpHome });
    writeProfiles("true");

    const before = await dispatchStatusJson("dispatch");
    const opencodeBefore = before.profiles.entries.find((p) => p.name === "opencode");
    expect(opencodeBefore?.ok).toBe(true);

    const refreshed = await bootstrapProfilesJson("dispatch", false);
    const opencodeAfter = refreshed.profiles.find((p) => p.name === "opencode");
    expect(opencodeAfter?.ok).toBe(true);
  });
});
