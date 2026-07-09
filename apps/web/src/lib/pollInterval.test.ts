import { describe, it, expect } from "bun:test";
import { clampInterval } from "./pollInterval";

describe("clampInterval", () => {
  it("returns the value when within bounds", () => {
    expect(clampInterval(5)).toBe(5);
    expect(clampInterval(2)).toBe(2);
    expect(clampInterval(30)).toBe(30);
  });

  it("clamps to the minimum and maximum", () => {
    expect(clampInterval(1)).toBe(2);
    expect(clampInterval(31)).toBe(30);
  });

  it("falls back to the minimum for invalid values", () => {
    expect(clampInterval(NaN)).toBe(2);
    expect(clampInterval(Infinity)).toBe(2);
    expect(clampInterval(null)).toBe(2);
    expect(clampInterval(undefined)).toBe(2);
  });
});
