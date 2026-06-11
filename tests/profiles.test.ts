import { describe, it, expect } from "bun:test";
import {
  loadProfiles,
  getProfile,
  substituteCommand,
  ensureProfiles,
  validateProfile,
} from "../src/profiles";
import { writeFileSync, unlinkSync, existsSync, readFileSync, rmdirSync } from "node:fs";

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
