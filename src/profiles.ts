import { readFileSync, existsSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";

export interface Profile {
  name: string;
  command: string;
  env?: Record<string, string>;
  agent?: string;
}

export function defaultProfilesPath(): string {
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

function shellEscape(value: string): string {
  if (value === "") {
    return "''";
  }
  // Escape single quotes by exiting the single-quoted string, inserting an
  // escaped single quote, and re-entering the quoted string. This makes the
  // value safe for POSIX shells when used inside single quotes.
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
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
    .replace(/\{\{title\}\}/g, shellEscape(vars.title ?? ""))
    .replace(/\{\{body\}\}/g, shellEscape(vars.body ?? ""))
    .replace(/\{\{result_file\}\}/g, vars.result_file ?? "");
}

/** Resolve the leading binary token of a harness command against PATH.
 * ponytail: pure stat over PATH entries, no shell exec. Per-tick cheap; add a
 * per-profile liveness cache if dispatch latency ever shows it. */
export function resolveCommandBinary(command: string): { binary: string; resolvedPath: string | null } {
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  if (!firstToken) return { binary: "", resolvedPath: null };

  if (firstToken.includes("/")) {
    try {
      accessSync(firstToken, constants.X_OK);
      return { binary: firstToken, resolvedPath: firstToken };
    } catch {
      return { binary: firstToken, resolvedPath: null };
    }
  }

  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const full = join(dir, firstToken);
    try {
      accessSync(full, constants.X_OK);
      return { binary: firstToken, resolvedPath: full };
    } catch {
      continue;
    }
  }
  return { binary: firstToken, resolvedPath: null };
}

export interface DoctorReportEntry {
  name: string;
  agent: string | undefined;
  command: string;
  binary: string;
  resolved_path: string | null;
  ok: boolean;
  status: "ok" | "missing-binary" | "parse-error";
}

/** Load the merged profile set and resolve each profile's leading binary. */
export function doctorProfiles(path: string = defaultProfilesPath()): DoctorReportEntry[] {
  const profiles = loadProfiles(path);
  return profiles.map((p) => {
    const { binary, resolvedPath } = resolveCommandBinary(p.command);
    let status: DoctorReportEntry["status"] = "ok";
    if (!binary) status = "parse-error";
    else if (!resolvedPath) status = "missing-binary";
    return {
      name: p.name,
      agent: p.agent,
      command: p.command,
      binary,
      resolved_path: resolvedPath,
      ok: status === "ok",
      status,
    };
  });
}

/** Write known-good real `opencode` and `pi` profile entries to the profiles
 * YAML, preserving other entries and (without --force) existing opencode/pi. */
export function bootstrapRealProfiles(
  path: string = defaultProfilesPath(),
  force = false
): { name: string; action: "written" | "preserved" | "overwritten"; command: string }[] {
  const want = BUILTIN_PROFILES.filter((p) => p.name === "opencode" || p.name === "pi");
  mkdirSync(dirname(path), { recursive: true });

  let existing: Profile[] = [];
  if (existsSync(path)) {
    const parsed = YAML.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) {
      existing = (parsed as unknown[]).map((p, i) => validateProfile(p, i));
    }
  }

  const byName = new Map(existing.map((p) => [p.name, p]));
  const results: { name: string; action: "written" | "preserved" | "overwritten"; command: string }[] = [];

  for (const w of want) {
    const had = byName.has(w.name);
    if (had && !force) {
      results.push({ name: w.name, action: "preserved", command: byName.get(w.name)!.command });
      continue;
    }
    byName.set(w.name, w);
    results.push({ name: w.name, action: had ? "overwritten" : "written", command: w.command });
  }

  writeFileSync(path, YAML.stringify(Array.from(byName.values())), "utf-8");
  return results;
}
