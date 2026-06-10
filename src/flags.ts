export const FF_ENABLE_KANBAN_DISPATCH = "FF_ENABLE_KANBAN_DISPATCH";

const flagRegistry = new Map<string, boolean>();
const flagOverrides = new Map<string, boolean>();

export function registerFlag(flag: string, defaultValue: boolean): void {
  flagRegistry.set(flag, defaultValue);
}

export function setFlag(flag: string, value: boolean): void {
  flagOverrides.set(flag, value);
}

export function isEnabled(flag: string): boolean {
  // Check env var first
  const envValue = Bun.env[flag];
  if (envValue !== undefined) {
    return envValue === "1" || envValue.toLowerCase() === "true";
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

// Register built-in flags
registerFlag(FF_ENABLE_KANBAN_DISPATCH, false);
