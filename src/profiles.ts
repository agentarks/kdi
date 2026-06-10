import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export interface Profile {
  name: string;
  command: string;
  env?: Record<string, string>;
  agent?: string;
}

const DEFAULT_PROFILES_PATH = join(homedir(), ".config/kdi/profiles.yaml");

const BUILTIN_PROFILES: Profile[] = [
  {
    name: "opencode",
    command: "opencode run --agent {{agent}} --cwd {{workdir}}",
    agent: "opencode",
  },
  {
    name: "claude",
    command: "claude {{task_id}} --workdir {{workdir}} --branch {{branch}}",
    agent: "claude",
  },
  {
    name: "codex",
    command: "codex --cwd {{workdir}} --branch {{branch}} {{task_id}}",
    agent: "codex",
  },
  {
    name: "pi",
    command: "pi run --agent {{agent}} --cwd {{workdir}}",
    agent: "pi",
  },
];

export function loadProfiles(path: string = DEFAULT_PROFILES_PATH): Profile[] {
  if (existsSync(path)) {
    const content = readFileSync(path, "utf-8");
    return YAML.parse(content) as Profile[];
  }
  return BUILTIN_PROFILES;
}

export function getProfile(name: string): Profile {
  const profiles = loadProfiles();
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    throw new Error("Unknown profile");
  }
  return profile;
}

export function substituteCommand(
  template: string,
  vars: {
    workdir: string;
    branch: string;
    task_id: string;
    agent: string;
  }
): string {
  return template
    .replace(/\{\{workdir\}\}/g, vars.workdir)
    .replace(/\{\{branch\}\}/g, vars.branch)
    .replace(/\{\{task_id\}\}/g, vars.task_id)
    .replace(/\{\{agent\}\}/g, vars.agent);
}
