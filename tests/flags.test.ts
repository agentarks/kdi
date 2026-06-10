import { describe, it, expect } from "bun:test";
import { isEnabled, setFlag, registerFlag, FF_ENABLE_KANBAN_DISPATCH } from "../src/flags";

describe("flags", () => {
  it("FF_ENABLE_KANBAN_DISPATCH defaults to false", () => {
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
  });

  it("setFlag overrides the default value", () => {
    setFlag(FF_ENABLE_KANBAN_DISPATCH, true);
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
    // Reset
    setFlag(FF_ENABLE_KANBAN_DISPATCH, false);
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
  });

  it("unknown flags return false", () => {
    expect(isEnabled("FF_UNKNOWN_FLAG")).toBe(false);
  });
});
