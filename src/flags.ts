export const FF_ENABLE_KANBAN_DISPATCH = "FF_ENABLE_KANBAN_DISPATCH";
export const FF_SCHEDULED_STATUS = "FF_SCHEDULED_STATUS";
export const FF_REVIEW_STATUS = "FF_REVIEW_STATUS";
export const FF_COMPLETE_METADATA = "FF_COMPLETE_METADATA";
export const FF_PRIORITY_INTEGER = "FF_PRIORITY_INTEGER";
export const FF_MAX_RUNTIME = "FF_MAX_RUNTIME";
export const FF_SKILLS_ARRAY = "FF_SKILLS_ARRAY";
export const FF_TENANT_NAMESPACE = "FF_TENANT_NAMESPACE";
export const FF_CREATED_BY = "FF_CREATED_BY";
export const FF_MODEL_OVERRIDE = "FF_MODEL_OVERRIDE";
export const FF_MAX_RETRIES = "FF_MAX_RETRIES";
export const FF_BOARD_METADATA = "FF_BOARD_METADATA";
export const FF_BOARD_RM_DELETE = "FF_BOARD_RM_DELETE";
export const FF_BOARD_RENAME = "FF_BOARD_RENAME";
export const FF_BOARD_SWITCH = "FF_BOARD_SWITCH";
export const FF_DEFAULT_WORKDIR = "FF_DEFAULT_WORKDIR";
export const FF_STATS = "FF_STATS";

const flagRegistry = new Map<string, boolean>();
const flagOverrides = new Map<string, boolean>();

export function registerFlag(flag: string, defaultValue: boolean): void {
  flagRegistry.set(flag, defaultValue);
}

export function setFlag(flag: string, value: boolean): void {
  flagOverrides.set(flag, value);
}

export function isEnabled(flag: string): boolean {
  // Security: only check env vars for registered flags
  if (flagRegistry.has(flag)) {
    const envValue = Bun.env[flag];
    if (envValue !== undefined) {
      const trimmed = envValue.trim();
      return trimmed === "1" || trimmed.toLowerCase() === "true";
    }
  }

  // Check programmatic override
  if (flagOverrides.has(flag)) {
    return flagOverrides.get(flag)!;
  }

  // Check registry default
  if (flagRegistry.has(flag)) {
    return flagRegistry.get(flag)!;
  }

  // Unknown flags default to false
  return false;
}

export function clearOverrides(): void {
  flagOverrides.clear();
}

// Register built-in flags
registerFlag(FF_ENABLE_KANBAN_DISPATCH, false);
registerFlag(FF_SCHEDULED_STATUS, false);
registerFlag(FF_REVIEW_STATUS, false);
registerFlag(FF_COMPLETE_METADATA, false);
registerFlag(FF_PRIORITY_INTEGER, false);
registerFlag(FF_MAX_RUNTIME, false);
registerFlag(FF_SKILLS_ARRAY, false);
registerFlag(FF_TENANT_NAMESPACE, false);
registerFlag(FF_CREATED_BY, false);
registerFlag(FF_MODEL_OVERRIDE, false);
registerFlag(FF_MAX_RETRIES, false);
registerFlag(FF_BOARD_METADATA, false);
registerFlag(FF_BOARD_RM_DELETE, false);
registerFlag(FF_BOARD_RENAME, false);
registerFlag(FF_BOARD_SWITCH, false);
registerFlag(FF_DEFAULT_WORKDIR, false);
registerFlag(FF_STATS, false);
