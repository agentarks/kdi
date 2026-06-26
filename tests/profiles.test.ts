import { describe, it, expect } from "bun:test";
import {
  loadProfiles,
  getProfile,
  substituteCommand,
  ensureProfiles,
  validateProfile,
  resolveCommandBinary,
  doctorProfiles,
  bootstrapRealProfiles,
  BUILTIN_PROFILES,
} from "../src/profiles";
import { writeFileSync, unlinkSync, existsSync, readFileSync, rmdirSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";

const TEST_PROFILES_PATH = "/tmp/kdi-test-profiles.yaml";

describe("profiles", () => {
  it("loads built-in profiles when file is missing", () => {
    const profiles = loadProfiles("/nonexistent/path.yaml");
    expect(profiles).toHaveLength(4);
    const names = profiles.map((p: any) => p.name);
    expect(names).toContain("opencode");
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    expect(names).toContain("pi");
  });

  it("loads custom profiles from YAML file", () => {
    const yaml = `
- name: custom
  command: echo {{workdir}}
- name: another
  command: echo {{branch}}
  agent: assistant
`;
    writeFileSync(TEST_PROFILES_PATH, yaml);
    try {
      const profiles = loadProfiles(TEST_PROFILES_PATH);
      expect(profiles).toHaveLength(6);
      const custom = profiles.filter((p: any) => p.name === "custom" || p.name === "another");
      expect(custom).toHaveLength(2);
      expect(custom[0].name).toBe("custom");
      expect(custom[0].command).toBe("echo {{workdir}}");
      expect(custom[1].name).toBe("another");
      expect(custom[1].agent).toBe("assistant");
    } finally {
      unlinkSync(TEST_PROFILES_PATH);
    }
  });

  it("substitutes template variables", () => {
    const result = substituteCommand(
      "opencode run --agent {{agent}} --cwd {{workdir}} --branch {{branch}} --task {{task_id}}",
      {
        workdir: "/home/user/project",
        branch: "main",
        task_id: "123",
        agent: "coder",
      }
    );
    expect(result).toBe(
      "opencode run --agent coder --cwd /home/user/project --branch main --task 123"
    );
  });

  it("throws Unknown profile for non-existent profile", () => {
    loadProfiles(); // load defaults
    expect(() => getProfile("nonexistent")).toThrow("Unknown profile");
  });

  it("getProfile returns correct profile", () => {
    const profiles = loadProfiles("/nonexistent/path.yaml");
    const profile = profiles.find((p: any) => p.name === "opencode");
    expect(profile!.name).toBe("opencode");
    expect(profile!.command).toContain("opencode");
  });

  it("rejects profiles missing command field", () => {
    const yaml = `
- name: bad-profile
  agent: assistant
`;
    writeFileSync(TEST_PROFILES_PATH, yaml);
    try {
      expect(() => loadProfiles(TEST_PROFILES_PATH)).toThrow("command");
    } finally {
      unlinkSync(TEST_PROFILES_PATH);
    }
  });

  it("merges custom profiles with built-ins (custom overrides)", () => {
    const yaml = `
- name: opencode
  command: custom-opencode-cmd
- name: custom
  command: echo hello
`;
    writeFileSync(TEST_PROFILES_PATH, yaml);
    try {
      const profiles = loadProfiles(TEST_PROFILES_PATH);
      const names = profiles.map((p: any) => p.name);
      expect(names).toContain("claude");
      expect(names).toContain("codex");
      expect(names).toContain("pi");
      expect(names).toContain("custom");
      const opencode = profiles.find((p: any) => p.name === "opencode");
      expect(opencode!.command).toBe("custom-opencode-cmd");
    } finally {
      unlinkSync(TEST_PROFILES_PATH);
    }
  });

  it("ensureProfiles writes built-in profiles when file is missing", () => {
    const testPath = "/tmp/kdi-ensure-profiles.yaml";
    if (existsSync(testPath)) {
      unlinkSync(testPath);
    }
    ensureProfiles(testPath);
    try {
      expect(existsSync(testPath)).toBe(true);
      const content = readFileSync(testPath, "utf-8");
      expect(content).toContain("opencode");
      expect(content).toContain("claude");
      expect(content).toContain("codex");
      expect(content).toContain("pi");
    } finally {
      unlinkSync(testPath);
    }
  });

  it("ensureProfiles is a no-op when file already exists", () => {
    const testPath = "/tmp/kdi-ensure-existing.yaml";
    writeFileSync(testPath, "custom: true\n");
    ensureProfiles(testPath);
    try {
      const content = readFileSync(testPath, "utf-8");
      expect(content).toBe("custom: true\n");
    } finally {
      unlinkSync(testPath);
    }
  });

  it("validateProfile rejects missing name", () => {
    expect(() => validateProfile({ command: "echo" }, 0)).toThrow("name");
  });

  it("validateProfile rejects empty name", () => {
    expect(() => validateProfile({ name: "", command: "echo" }, 0)).toThrow("name");
  });

  it("validateProfile rejects missing command", () => {
    expect(() => validateProfile({ name: "test" }, 0)).toThrow("command");
  });

  it("validateProfile rejects empty command", () => {
    expect(() => validateProfile({ name: "test", command: "   " }, 0)).toThrow("command");
  });

  it("validateProfile rejects non-string agent", () => {
    expect(() => validateProfile({ name: "test", command: "echo", agent: 123 }, 0)).toThrow(
      "agent"
    );
  });

  it("validateProfile rejects non-object env", () => {
    expect(() => validateProfile({ name: "test", command: "echo", env: "bad" }, 0)).toThrow(
      "env"
    );
  });

  it("validateProfile rejects non-string env values", () => {
    expect(() =>
      validateProfile({ name: "test", command: "echo", env: { FOO: 123 } }, 0)
    ).toThrow("env");
  });

  it("validateProfile rejects unknown fields", () => {
    expect(() =>
      validateProfile({ name: "test", command: "echo", extra: "bad" }, 0)
    ).toThrow("unknown field");
  });

  it("validateProfile rejects unknown template variables", () => {
    expect(() =>
      validateProfile({ name: "test", command: "echo {{unknown}}" }, 0)
    ).toThrow("unknown template variable");
  });

  it("validateProfile allows known template variables", () => {
    const p = validateProfile(
      { name: "test", command: "echo {{workdir}} {{branch}} {{task_id}} {{agent}}" },
      0
    );
    expect(p.name).toBe("test");
    expect(p.command).toBe("echo {{workdir}} {{branch}} {{task_id}} {{agent}}");
  });

  it("validateProfile allows {{step_key}} template variable", () => {
    const p = validateProfile(
      { name: "test", command: "echo {{step_key}}" },
      0
    );
    expect(p.command).toBe("echo {{step_key}}");
  });

  it("validateProfile allows {{title}} and {{body}} template variables", () => {
    const p = validateProfile(
      { name: "test", command: "echo {{title}} {{body}}" },
      0
    );
    expect(p.command).toBe("echo {{title}} {{body}}");
  });

  it("substitutes {{title}} and {{body}} when provided", () => {
    const result = substituteCommand(
      "agent --title {{title}} --body {{body}}",
      {
        workdir: "/tmp/wt",
        branch: "main",
        task_id: "7",
        agent: "coder",
        title: "Fix the thing",
        body: "Detailed description\nwith newline",
      }
    );
    expect(result).toBe("agent --title 'Fix the thing' --body 'Detailed description\nwith newline'");
  });

  it("substitutes {{title}} and {{body}} with empty string when absent", () => {
    const result = substituteCommand(
      "agent --title {{title}} --body {{body}}",
      {
        workdir: "/tmp/wt",
        branch: "main",
        task_id: "7",
        agent: "coder",
      }
    );
    expect(result).toBe("agent --title '' --body ''");
  });

  it("shell-escapes {{title}} and {{body}}", () => {
    const result = substituteCommand(
      "agent --title {{title}} --body {{body}}",
      {
        workdir: "/tmp/wt",
        branch: "main",
        task_id: "7",
        agent: "coder",
        title: "it's done",
        body: "$(rm -rf /)",
      }
    );
    expect(result).toBe("agent --title 'it'\"'\"'s done' --body '$(rm -rf /)'");
  });

  it("substitutes {{step_key}} when provided", () => {
    const result = substituteCommand(
      "agent --step {{step_key}} --task {{task_id}}",
      {
        workdir: "/tmp/wt",
        branch: "main",
        task_id: "7",
        agent: "coder",
        step_key: "review",
      }
    );
    expect(result).toBe("agent --step review --task 7");
  });

  it("substitutes {{step_key}} with empty string when absent", () => {
    const result = substituteCommand(
      "agent --step {{step_key}} --task {{task_id}}",
      {
        workdir: "/tmp/wt",
        branch: "main",
        task_id: "7",
        agent: "coder",
      }
    );
    expect(result).toBe("agent --step  --task 7");
  });

  it("validateProfile allows {{skills}} template variable", () => {
    const p = validateProfile(
      { name: "test", command: "echo {{skills}}" },
      0
    );
    expect(p.command).toBe("echo {{skills}}");
  });

  it("substitutes {{skills}} with comma-separated values", () => {
    const result = substituteCommand(
      "opencode run --skills {{skills}} --cwd {{workdir}}",
      {
        workdir: "/home/user/project",
        branch: "main",
        task_id: "123",
        agent: "coder",
        skills: "github,code-review",
      }
    );
    expect(result).toBe(
      "opencode run --skills github,code-review --cwd /home/user/project"
    );
  });

  it("loadProfiles falls back to built-ins for empty file", () => {
    writeFileSync(TEST_PROFILES_PATH, "");
    try {
      const profiles = loadProfiles(TEST_PROFILES_PATH);
      expect(profiles).toHaveLength(4);
    } finally {
      unlinkSync(TEST_PROFILES_PATH);
    }
  });

  it("loadProfiles throws for non-array YAML", () => {
    writeFileSync(TEST_PROFILES_PATH, "foo: bar");
    try {
      expect(() => loadProfiles(TEST_PROFILES_PATH)).toThrow("YAML array");
    } finally {
      unlinkSync(TEST_PROFILES_PATH);
    }
  });
});

describe("resolveCommandBinary", () => {
  it("resolves a binary on PATH (echo)", () => {
    const r = resolveCommandBinary("echo hello world");
    expect(r.binary).toBe("echo");
    expect(r.resolvedPath).not.toBeNull();
    expect(existsSync(r.resolvedPath!)).toBe(true);
  });

  it("returns null resolvedPath for a missing binary", () => {
    const r = resolveCommandBinary("/tmp/mock-harness run");
    expect(r.binary).toBe("/tmp/mock-harness");
    expect(r.resolvedPath).toBeNull();
  });

  it("returns null resolvedPath for a bare missing name", () => {
    const r = resolveCommandBinary("definitely-not-a-real-binary-xyzzy {{workdir}}");
    expect(r.binary).toBe("definitely-not-a-real-binary-xyzzy");
    expect(r.resolvedPath).toBeNull();
  });

  it("resolves an absolute executable path", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-bin-"));
    const binPath = join(dir, "fake-harness");
    writeFileSync(binPath, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    try {
      const r = resolveCommandBinary(`${binPath} --cwd {{workdir}}`);
      expect(r.binary).toBe(binPath);
      expect(r.resolvedPath).toBe(binPath);
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });

  it("returns null for an empty command", () => {
    const r = resolveCommandBinary("   ");
    expect(r.binary).toBe("");
    expect(r.resolvedPath).toBeNull();
  });
});

describe("doctorProfiles", () => {
  it("reports ok for a profile whose binary resolves (echo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-dr-"));
    const path = join(dir, "profiles.yaml");
    writeFileSync(path, YAML.stringify([{ name: "echoer", command: "echo hi" }]));
    try {
      const report = doctorProfiles(path);
      const r = report.find((e) => e.name === "echoer");
      expect(r).toBeDefined();
      expect(r!.status).toBe("ok");
      expect(r!.ok).toBe(true);
      expect(r!.resolved_path).not.toBeNull();
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });

  it("reports missing-binary for a stale /tmp/mock-harness profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-dr-"));
    const path = join(dir, "profiles.yaml");
    writeFileSync(path, YAML.stringify([{ name: "stale", command: "/tmp/mock-harness run" }]));
    try {
      const report = doctorProfiles(path);
      const r = report.find((e) => e.name === "stale");
      expect(r).toBeDefined();
      expect(r!.status).toBe("missing-binary");
      expect(r!.ok).toBe(false);
      expect(r!.binary).toBe("/tmp/mock-harness");
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });
});

describe("bootstrapRealProfiles", () => {
  const wantNames = ["opencode", "pi"];

  it("writes opencode+pi entries when none exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-boot-"));
    const path = join(dir, "profiles.yaml");
    try {
      const results = bootstrapRealProfiles(path, false);
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(wantNames);
      expect(results.every((r) => r.action === "written")).toBe(true);
      const parsed = YAML.parse(readFileSync(path, "utf-8")) as any[];
      const parsedNames = parsed.map((p) => p.name).sort();
      expect(parsedNames).toEqual(wantNames);
      expect(parsed.find((p) => p.name === "opencode").command).toBe(
        BUILTIN_PROFILES.find((p) => p.name === "opencode")!.command
      );
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });

  it("preserves existing opencode/pi entries without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-boot-"));
    const path = join(dir, "profiles.yaml");
    writeFileSync(path, YAML.stringify([{ name: "opencode", command: "my-opencode --cwd {{workdir}}" }]));
    try {
      const results = bootstrapRealProfiles(path, false);
      const oc = results.find((r) => r.name === "opencode");
      expect(oc!.action).toBe("preserved");
      const parsed = YAML.parse(readFileSync(path, "utf-8")) as any[];
      expect(parsed.find((p) => p.name === "opencode").command).toBe("my-opencode --cwd {{workdir}}");
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });

  it("overwrites existing opencode/pi entries with --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-boot-"));
    const path = join(dir, "profiles.yaml");
    writeFileSync(path, YAML.stringify([{ name: "opencode", command: "my-opencode --cwd {{workdir}}" }]));
    try {
      const results = bootstrapRealProfiles(path, true);
      const oc = results.find((r) => r.name === "opencode");
      expect(oc!.action).toBe("overwritten");
      const parsed = YAML.parse(readFileSync(path, "utf-8")) as any[];
      expect(parsed.find((p) => p.name === "opencode").command).toBe(
        BUILTIN_PROFILES.find((p) => p.name === "opencode")!.command
      );
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });

  it("preserves unrelated custom entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "kdi-boot-"));
    const path = join(dir, "profiles.yaml");
    writeFileSync(path, YAML.stringify([{ name: "custom", command: "echo {{workdir}}" }]));
    try {
      bootstrapRealProfiles(path, false);
      const parsed = YAML.parse(readFileSync(path, "utf-8")) as any[];
      expect(parsed.find((p) => p.name === "custom").command).toBe("echo {{workdir}}");
    } finally {
      rmdirSync(dir, { recursive: true } as any);
    }
  });
});
