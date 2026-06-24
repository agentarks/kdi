import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";

export interface Profile {
  name: string;
  command: string;
  env?: Record<string, string>;
  agent?: string;
}

function defaultProfilesPath(): string {
  return process.env.KDI_PROFILES_PATH || join(homedir(), ".config/kdi/profiles.yaml");
}
const ALLOWED_FIELDS = new Set(["name", "command", "agent", "env"]);
const ALLOWED_TEMPLATES = new Set(["workdir", "branch", "task_id", "agent", "skills", "model", "step_key", "title", "body", "result_file"]);

export const BUILTIN_PROFILES: Profile[] = [
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

export function validateProfile(profile: unknown, index: number): Profile {
  if (typeof profile !== "object" || profile === null) {
    throw new Error(`Profile at index ${index} must be an object`);
  }

  const p = profile as Record<string, unknown>;

  if (typeof p.name !== "string" || p.name.trim() === "") {
    throw new Error(`Profile at index ${index} is missing required field "name"`);
  }

  if (typeof p.command !== "string" || p.command.trim() === "") {
    throw new Error(`Profile "${p.name}" is missing required field "command"`);
  }

  if ("agent" in p && typeof p.agent !== "string") {
    throw new Error(`Profile "${p.name}" field "agent" must be a string`);
  }

  if ("env" in p) {
    if (typeof p.env !== "object" || p.env === null || Array.isArray(p.env)) {
      throw new Error(`Profile "${p.name}" field "env" must be an object`);
    }
    for (const [key, value] of Object.entries(p.env)) {
      if (typeof value !== "string") {
        throw new Error(`Profile "${p.name}" env value for "${key}" must be a string`);
      }
    }
  }

  for (const key of Object.keys(p)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`Profile "${p.name}" has unknown field "${key}"`);
    }
  }

  const templateVars = Array.from(p.command.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)).map((m) => m[1]);
  for (const v of templateVars) {
    if (!ALLOWED_TEMPLATES.has(v)) {
      throw new Error(
        `Profile "${p.name}" uses unknown template variable "{{${v}}}". Allowed: ${Array.from(ALLOWED_TEMPLATES).map((t) => `{{${t}}}`).join(", ")}`
      );
    }
  }

  return p as unknown as Profile;
}

export function ensureProfiles(path: string = defaultProfilesPath()): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(BUILTIN_PROFILES), "utf-8");
}

export function loadProfiles(path: string = defaultProfilesPath()): Profile[] {
  if (!existsSync(path)) {
    return [...BUILTIN_PROFILES];
  }

  const content = readFileSync(path, "utf-8");
  const parsed = YAML.parse(content);

  if (parsed === null || parsed === undefined) {
    return [...BUILTIN_PROFILES];
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Profiles file must contain a YAML array of profiles`);
  }

  const custom: Profile[] = [];
  for (let i = 0; i < parsed.length; i++) {
    custom.push(validateProfile(parsed[i], i));
  }

  const customNames = new Set(custom.map((p) => p.name));
  const builtins = BUILTIN_PROFILES.filter((p) => !customNames.has(p.name));
  return [...builtins, ...custom];
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
    skills?: string;
    model?: string;
    step_key?: string;
    title?: string;
    body?: string;
    result_file?: string;
  }
): string {
  return template
    .replace(/\{\{workdir\}\}/g, vars.workdir)
    .replace(/\{\{branch\}\}/g, vars.branch)
    .replace(/\{\{task_id\}\}/g, vars.task_id)
    .replace(/\{\{agent\}\}/g, vars.agent)
    .replace(/\{\{skills\}\}/g, vars.skills ?? "")
    .replace(/\{\{model\}\}/g, vars.model ?? "")
    .replace(/\{\{step_key\}\}/g, vars.step_key ?? "")
    .replace(/\{\{title\}\}/g, vars.title ?? "")
    .replace(/\{\{body\}\}/g, vars.body ?? "")
    .replace(/\{\{result_file\}\}/g, vars.result_file ?? "");
}
