import { describe, it, expect } from "bun:test";
import { loadProfiles, getProfile, substituteCommand } from "../src/profiles";
import { writeFileSync, unlinkSync } from "node:fs";

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
});
