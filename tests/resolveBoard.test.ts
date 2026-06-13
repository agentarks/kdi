import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getCurrentBoardFilePath,
  readCurrentBoard,
  writeCurrentBoard,
  resolveBoard,
} from "../src/resolveBoard";

const ORIGINAL_KDI_BOARD = process.env.KDI_BOARD;

describe("resolveBoard", () => {
  beforeEach(() => {
    delete process.env.KDI_BOARD;
    // Clean up current board file
    const path = getCurrentBoardFilePath();
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  });

  afterEach(() => {
    if (ORIGINAL_KDI_BOARD !== undefined) {
      process.env.KDI_BOARD = ORIGINAL_KDI_BOARD;
    } else {
      delete process.env.KDI_BOARD;
    }
    const path = getCurrentBoardFilePath();
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  });

  it("resolveBoard defaults to 'default' when no chain has a value", () => {
    const slug = resolveBoard();
    expect(slug).toBe("default");
  });

  it("resolveBoard returns explicit slug when provided", () => {
    const slug = resolveBoard("my-board");
    expect(slug).toBe("my-board");
  });

  it("resolveBoard prefers explicit slug over KDI_BOARD env", () => {
    process.env.KDI_BOARD = "env-board";
    const slug = resolveBoard("explicit-board");
    expect(slug).toBe("explicit-board");
  });

  it("resolveBoard returns KDI_BOARD env when no explicit slug", () => {
    process.env.KDI_BOARD = "env-board";
    const slug = resolveBoard();
    expect(slug).toBe("env-board");
  });

  it("resolveBoard falls through to current file when no explicit or env", () => {
    writeCurrentBoard("current-board");
    const slug = resolveBoard();
    expect(slug).toBe("current-board");
  });

  it("resolveBoard prefers explicit over current file", () => {
    writeCurrentBoard("current-board");
    const slug = resolveBoard("explicit-board");
    expect(slug).toBe("explicit-board");
  });

  it("resolveBoard prefers KDI_BOARD env over current file", () => {
    writeCurrentBoard("current-board");
    process.env.KDI_BOARD = "env-board";
    const slug = resolveBoard();
    expect(slug).toBe("env-board");
  });

  it("writeCurrentBoard writes slug to the current file", () => {
    writeCurrentBoard("test-board");
    const path = getCurrentBoardFilePath();
    expect(existsSync(path)).toBe(true);
    const content = readCurrentBoard();
    expect(content).toBe("test-board");
  });

  it("readCurrentBoard returns null when file does not exist", () => {
    const content = readCurrentBoard();
    expect(content).toBeNull();
  });

  it("writeCurrentBoard overwrites existing current file", () => {
    writeCurrentBoard("first-board");
    writeCurrentBoard("second-board");
    const content = readCurrentBoard();
    expect(content).toBe("second-board");
  });
});
