import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { initDb } from "../../src/db";
import { cleanupDb } from "../cleanupDb";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

describe("kdi profiles (FF_REAL_HARNESS_PROFILES)", () => {
  let tmp: string;
  let home: string;
  let profilesPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kdi-profiles-cli-"));
    home = join(tmp, "home");
    profilesPath = join(home, ".config", "kdi", "profiles.yaml");
    mkdirSync(join(home, ".config", "kdi"), { recursive: true });
    dbPath = join(tmp, "kdi.db");
    cleanupDb(dbPath);
    initDb(dbPath);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    cleanupDb(dbPath);
  });

  function runKdi(args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } {
    try {
      const result = execFileSync("bun", ["run", "src/index.ts", ...args], {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: home,
          KDI_DB: dbPath,
          KDI_PROFILES_PATH: profilesPath,
          ...env,
        },
      });
      return { ok: true, stdout: result, stderr: "" };
    } catch (err: any) {
      return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
    }
  }

  it("rejects doctor when the flag is off", () => {
    const r = runKdi(["profiles", "doctor"], { FF_REAL_HARNESS_PROFILES: "false" });
    expect(r.ok).toBe(false);
    expect(r.stdout + r.stderr).toContain("FF_REAL_HARNESS_PROFILES is disabled");
  });

  it("rejects bootstrap when the flag is off", () => {
    const r = runKdi(["profiles", "bootstrap"], { FF_REAL_HARNESS_PROFILES: "false" });
    expect(r.ok).toBe(false);
    expect(r.stdout + r.stderr).toContain("FF_REAL_HARNESS_PROFILES is disabled");
  });

  it("doctor reports a stale /tmp/mock-harness profile as missing-binary and exits 1", () => {
    writeFileSync(
      profilesPath,
      YAML.stringify([{ name: "stale", command: "/tmp/mock-harness run --cwd {{workdir}}" }])
    );
    const r = runKdi(["profiles", "doctor"], { FF_REAL_HARNESS_PROFILES: "true" });
    expect(r.ok).toBe(false);
    expect(r.stdout).toContain("stale");
    expect(r.stdout).toContain("missing-binary");
    expect(r.stdout).toContain("NOT FOUND");
  });

  it("doctor --json produces a parseable document with the stale entry", () => {
    writeFileSync(
      profilesPath,
      YAML.stringify([{ name: "stale", command: "/tmp/mock-harness run" }])
    );
    const r = runKdi(["profiles", "doctor", "--json"], { FF_REAL_HARNESS_PROFILES: "true" });
    // --json path exits 1 when unhealthy; stdout still carries the JSON.
    const doc = JSON.parse(r.stdout) as Array<{ name: string; status: string; binary: string }>;
    const stale = doc.find((e) => e.name === "stale");
    expect(stale).toBeDefined();
    expect(stale!.status).toBe("missing-binary");
    expect(stale!.binary).toBe("/tmp/mock-harness");
  });

  it("bootstrap writes opencode and pi entries when absent", () => {
    expect(existsSync(profilesPath)).toBe(false);
    const r = runKdi(["profiles", "bootstrap"], { FF_REAL_HARNESS_PROFILES: "true" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("opencode");
    expect(r.stdout).toContain("pi");
    const parsed = YAML.parse(readFileSync(profilesPath, "utf-8")) as Array<{ name: string }>;
    const names = parsed.map((p) => p.name);
    expect(names).toContain("opencode");
    expect(names).toContain("pi");
  });

  it("bootstrap --force overwrites an existing opencode entry", () => {
    writeFileSync(
      profilesPath,
      YAML.stringify([{ name: "opencode", command: "my-opencode --cwd {{workdir}}" }])
    );
    const r = runKdi(["profiles", "bootstrap", "--force"], { FF_REAL_HARNESS_PROFILES: "true" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("overwritten");
    const parsed = YAML.parse(readFileSync(profilesPath, "utf-8")) as Array<{ name: string; command: string }>;
    expect(parsed.find((p) => p.name === "opencode")!.command).toContain("opencode run");
  });

  it("bootstrap without --force preserves an existing opencode entry", () => {
    writeFileSync(
      profilesPath,
      YAML.stringify([{ name: "opencode", command: "my-opencode --cwd {{workdir}}" }])
    );
    const r = runKdi(["profiles", "bootstrap"], { FF_REAL_HARNESS_PROFILES: "true" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("preserved");
    const parsed = YAML.parse(readFileSync(profilesPath, "utf-8")) as Array<{ name: string; command: string }>;
    expect(parsed.find((p) => p.name === "opencode")!.command).toBe("my-opencode --cwd {{workdir}}");
  });
});