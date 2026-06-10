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
      expect(profiles).toHaveLength(2);
      expect(profiles[0].name).toBe("custom");
      expect(profiles[0].command).toBe("echo {{workdir}}");
      expect(profiles[1].name).toBe("another");
      expect(profiles[1].agent).toBe("assistant");
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
    loadProfiles();
    const profile = getProfile("opencode");
    expect(profile.name).toBe("opencode");
    expect(profile.command).toContain("opencode");
  });
});
