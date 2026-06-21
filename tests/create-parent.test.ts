import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, KDI_BOARD: "myproj", FF_CREATE_PARENT: "true", ...env },
  }).trim();
}

describe("KDI-045 create --parent", () => {
  it("creates a task with a single parent dependency", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      const parentId = runKdi(`create "Parent"`, { KDI_DB: db });
      const childId = runKdi(`create "Child" --parent ${parentId}`, { KDI_DB: db });
      expect(() => runKdi(`promote ${childId}`, { KDI_DB: db, FF_BULK_OPERATIONS: "true" })).toThrow(/blocked_by_dependencies/);
      const show = runKdi(`show ${childId}`, { KDI_DB: db });
      expect(show).toContain("todo");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("creates a task with multiple parent dependencies", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      const p1 = runKdi(`create "P1"`, { KDI_DB: db });
      const p2 = runKdi(`create "P2"`, { KDI_DB: db });
      const childId = runKdi(`create "Child" --parent ${p1} --parent ${p2}`, { KDI_DB: db });
      expect(() => runKdi(`promote ${childId}`, { KDI_DB: db, FF_BULK_OPERATIONS: "true" })).toThrow(/blocked_by_dependencies/);
      const show = runKdi(`show ${childId}`, { KDI_DB: db });
      expect(show).toContain("todo");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects --parent when feature flag is disabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      expect(() =>
        runKdi(`create "Child" --parent 1`, { KDI_DB: db, FF_CREATE_PARENT: "false" })
      ).toThrow(/Create-parent feature is not enabled/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a missing parent task", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      expect(() =>
        runKdi(`create "Child" --parent 99`, { KDI_DB: db })
      ).toThrow(/Parent task 99 not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects self-dependency", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      const id = runKdi(`create "A" --idempotency-key a`, { KDI_DB: db });
      expect(() =>
        runKdi(`create "A" --parent ${id} --idempotency-key a`, { KDI_DB: db })
      ).toThrow(/Self-dependency/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects circular dependencies", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      const aId = runKdi(`create "A" --idempotency-key a`, { KDI_DB: db });
      const bId = runKdi(`create "B" --parent ${aId} --idempotency-key b`, { KDI_DB: db });
      expect(() =>
        runKdi(`create "A" --parent ${bId} --idempotency-key a`, { KDI_DB: db })
      ).toThrow(/Circular/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent when combined with --idempotency-key", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kdi-create-parent-"));
    const db = join(tmp, "kdi.db");
    try {
      runKdi(`boards create myproj --workdir /tmp/myproj`, { KDI_DB: db });
      const parentId = runKdi(`create "Parent"`, { KDI_DB: db });
      const id1 = runKdi(`create "Child" --parent ${parentId} --idempotency-key child`, { KDI_DB: db });
      const id2 = runKdi(`create "Child" --parent ${parentId} --idempotency-key child`, { KDI_DB: db });
      expect(id1).toBe(id2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
