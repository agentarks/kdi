import { describe, it, expect, beforeEach } from "bun:test";
import { isEnabled, setFlag, registerFlag, clearOverrides, FF_ENABLE_KANBAN_DISPATCH, FF_BOARD_RM_DELETE } from "../src/flags";

describe("flags", () => {
  beforeEach(() => {
    clearOverrides();
    delete Bun.env[FF_ENABLE_KANBAN_DISPATCH];
    delete Bun.env[FF_BOARD_RM_DELETE];
  });

  it("FF_ENABLE_KANBAN_DISPATCH defaults to true after rollout", () => {
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
  });

  it("setFlag overrides the default value", () => {
    setFlag(FF_ENABLE_KANBAN_DISPATCH, false);
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
    setFlag(FF_ENABLE_KANBAN_DISPATCH, true);
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
  });

  it("unknown flags return false", () => {
    expect(isEnabled("FF_UNKNOWN_FLAG")).toBe(false);
  });

  it("env var '1' enables the flag", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "1";
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
  });

  it("env var 'true' enables the flag", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "true";
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
  });

  it("env var '0' disables the flag", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "0";
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
  });

  it("env var 'false' disables the flag", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "false";
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
  });

  it("env var takes priority over programmatic override", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "0";
    setFlag(FF_ENABLE_KANBAN_DISPATCH, true);
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(false);
  });

  it("trims env values before comparison", () => {
    Bun.env[FF_ENABLE_KANBAN_DISPATCH] = "  true  ";
    expect(isEnabled(FF_ENABLE_KANBAN_DISPATCH)).toBe(true);
  });

  it("does not read env vars for unregistered flags", () => {
    Bun.env["FF_UNKNOWN_FLAG"] = "1";
    expect(isEnabled("FF_UNKNOWN_FLAG")).toBe(false);
    delete Bun.env["FF_UNKNOWN_FLAG"];
  });

  it("FF_BOARD_RM_DELETE defaults to false (still InDev)", () => {
    expect(isEnabled(FF_BOARD_RM_DELETE)).toBe(false);
  });
});
