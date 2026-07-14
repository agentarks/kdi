// KDI-UI-009 Slice 1: duration formatter for the oldest-ready-age stat.
import { describe, it, expect } from "bun:test";
import { formatDuration } from "./format";

describe("formatDuration (oldest-ready age, FR-6)", () => {
  it("formats sub-minute as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes-only under an hour", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(12 * 60)).toBe("12m");
  });

  it("formats hours+minutes compound (BRD example '3h 12m')", () => {
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(3600)).toBe("1h 0m");
  });

  it("formats days+hours compound past a day", () => {
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
    expect(formatDuration(86400)).toBe("1d 0h");
  });
});
