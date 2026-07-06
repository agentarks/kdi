import { describe, it, expect } from "bun:test";
import { statusLabel, formatAge, formatRemaining, isStale, isRateLimited, VALID_SORT_KEYS } from "./kanban";

describe("kanban helpers", () => {
  describe("statusLabel", () => {
    it("capitalises the first letter", () => {
      expect(statusLabel("blocked")).toBe("Blocked");
      expect(statusLabel("running")).toBe("Running");
    });
  });

  describe("formatAge", () => {
    const now = 1_000_000;

    it("returns 'just now' for recent tasks", () => {
      expect(formatAge(now - 30, now)).toBe("just now");
    });

    it("returns minutes", () => {
      expect(formatAge(now - 120, now)).toBe("2m");
    });

    it("returns hours", () => {
      expect(formatAge(now - 7_200, now)).toBe("2h");
    });

    it("returns days", () => {
      expect(formatAge(now - 172_800, now)).toBe("2d");
    });
  });

  describe("formatRemaining", () => {
    const now = 1_000_000;

    it("returns 'now' when time has passed", () => {
      expect(formatRemaining(now - 10, now)).toBe("now");
    });

    it("returns seconds", () => {
      expect(formatRemaining(now + 30, now)).toBe("30s");
    });

    it("returns minutes", () => {
      expect(formatRemaining(now + 1_800, now)).toBe("30m");
    });

    it("returns hours", () => {
      expect(formatRemaining(now + 7_200, now)).toBe("2h");
    });

    it("returns days", () => {
      expect(formatRemaining(now + 172_800, now)).toBe("2d");
    });
  });

  describe("isStale", () => {
    const now = 1_000_000;

    it("marks running tasks stale when heartbeat is old and heartbeat flag is enabled", () => {
      expect(
        isStale({ status: "running", updatedAt: now - 60, lastHeartbeatAt: now - 3_700 }, true, now),
      ).toBe(true);
    });

    it("ignores heartbeat when heartbeat flag is disabled", () => {
      expect(
        isStale({ status: "running", updatedAt: now - 60, lastHeartbeatAt: now - 3_700 }, false, now),
      ).toBe(false);
    });

    it("marks non-terminal tasks stale when updated long ago", () => {
      expect(isStale({ status: "ready", updatedAt: now - 86_500, lastHeartbeatAt: null }, false, now)).toBe(true);
    });

    it("does not mark done tasks stale", () => {
      expect(isStale({ status: "done", updatedAt: now - 86_500, lastHeartbeatAt: null }, false, now)).toBe(false);
    });

    it("does not mark archived tasks stale", () => {
      expect(isStale({ status: "archived", updatedAt: now - 86_500, lastHeartbeatAt: null }, false, now)).toBe(false);
    });
  });

  describe("isRateLimited", () => {
    const now = 1_000_000;

    it("returns true when rate_limited_until is in the future", () => {
      const task = { rateLimitedUntil: now + 300 };
      expect(isRateLimited(task, now)).toBe(true);
    });

    it("returns false when rate_limited_until is null", () => {
      expect(isRateLimited({ rateLimitedUntil: null }, now)).toBe(false);
    });

    it("returns false when rate_limited_until is in the past", () => {
      expect(isRateLimited({ rateLimitedUntil: now - 10 }, now)).toBe(false);
    });
  });

  describe("VALID_SORT_KEYS", () => {
    it("matches the CLI model sort keys", () => {
      expect(VALID_SORT_KEYS).toContain("created-desc");
      expect(VALID_SORT_KEYS).toContain("updated");
      expect(VALID_SORT_KEYS).toContain("priority-desc");
    });
  });
});
