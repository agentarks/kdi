import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initDb, closeDb, defaultDbPath } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard, removeBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import {
  createAttachment,
  listAttachments,
  getAttachment,
  type TaskAttachment,
} from "../src/models/taskAttachment";
import { getEvents } from "../src/models/taskEvent";
import { setFlag, clearOverrides, FF_BOARD_RM_DELETE } from "../src/flags";

const TEST_DB = "/tmp/kdi-task-attachment-test.db";

function cleanupAttachments() {
  const dataDir = dirname(defaultDbPath());
  try {
    rmSync(join(dataDir, "boards"), { recursive: true, force: true });
  } catch {}
}

describe("task attachment model", () => {
  let sourceDir: string;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    cleanupAttachments();
    process.env.KDI_DB = TEST_DB;
    initDb(TEST_DB);
    sourceDir = mkdtempSync(join(tmpdir(), "kdi-attach-"));
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    cleanupAttachments();
    clearOverrides();
    closeDb();
    try {
      rmSync(sourceDir, { recursive: true, force: true });
    } catch {}
  });

  it("createAttachment copies file and records metadata", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Attach me" });
    const sourcePath = join(sourceDir, "notes.txt");
    writeFileSync(sourcePath, "hello attachments");

    const attachment = createAttachment(task.id, sourcePath);

    expect(attachment.id).toBeNumber();
    expect(attachment.task_id).toBe(task.id);
    expect(attachment.filename).toBe("notes.txt");
    expect(attachment.stored_path).toContain("attachments");
    expect(attachment.stored_path).toContain(String(task.id));
    expect(attachment.stored_path).toContain("notes.txt");
    expect(attachment.content_type).toBe("text/plain");
    expect(attachment.size).toBe(17);
    expect(attachment.uploaded_by).toBeTruthy();
    expect(existsSync(attachment.stored_path)).toBe(true);

    const events = getEvents(task.id);
    const attached = events.find((e) => e.kind === "attached");
    expect(attached).toBeDefined();
    expect(attached?.payload).toContain("notes.txt");
  });

  it("createAttachment defaults uploaded_by from env", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Uploader" });
    const sourcePath = join(sourceDir, "file.txt");
    writeFileSync(sourcePath, "x");

    const originalProfile = process.env.KDI_PROFILE;
    process.env.KDI_PROFILE = "operator";
    try {
      const attachment = createAttachment(task.id, sourcePath);
      expect(attachment.uploaded_by).toBe("operator");
    } finally {
      if (originalProfile === undefined) {
        delete process.env.KDI_PROFILE;
      } else {
        process.env.KDI_PROFILE = originalProfile;
      }
    }
  });

  it("createAttachment accepts explicit uploaded_by", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Uploader" });
    const sourcePath = join(sourceDir, "file.txt");
    writeFileSync(sourcePath, "x");

    const attachment = createAttachment(task.id, sourcePath, "alice");
    expect(attachment.uploaded_by).toBe("alice");
  });

  it("createAttachment rejects missing file", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Missing" });

    expect(() => createAttachment(task.id, join(sourceDir, "missing.txt"))).toThrow(
      /File not found/
    );
  });

  it("createAttachment rejects directories", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Dir" });
    const dirPath = join(sourceDir, "folder");
    mkdirSync(dirPath);

    expect(() => createAttachment(task.id, dirPath)).toThrow(/Not a file/);
  });

  it("createAttachment rejects duplicate filenames for the same task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Dup" });
    const sourcePath = join(sourceDir, "dup.txt");
    writeFileSync(sourcePath, "first");

    createAttachment(task.id, sourcePath);

    expect(() => createAttachment(task.id, sourcePath)).toThrow(/already exists/);
  });

  it("createAttachment allows same filename on different tasks", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const taskA = createTask({ board_id: board.id, title: "A" });
    const taskB = createTask({ board_id: board.id, title: "B" });
    const sourcePath = join(sourceDir, "same.txt");
    writeFileSync(sourcePath, "content");

    const attachmentA = createAttachment(taskA.id, sourcePath);
    const attachmentB = createAttachment(taskB.id, sourcePath);

    expect(attachmentA.filename).toBe("same.txt");
    expect(attachmentB.filename).toBe("same.txt");
    expect(attachmentA.stored_path).not.toBe(attachmentB.stored_path);
  });

  it("listAttachments returns attachments ordered by created_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "List" });
    const pathA = join(sourceDir, "a.txt");
    const pathB = join(sourceDir, "b.txt");
    writeFileSync(pathA, "a");
    writeFileSync(pathB, "b");

    const attachmentA = createAttachment(task.id, pathA);
    const attachmentB = createAttachment(task.id, pathB);

    const attachments = listAttachments(task.id);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].id).toBe(attachmentA.id);
    expect(attachments[1].id).toBe(attachmentB.id);
  });

  it("getAttachment returns null for unknown id", () => {
    expect(getAttachment(99999)).toBeNull();
  });

  it("getAttachment returns attachment", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Get" });
    const sourcePath = join(sourceDir, "get.txt");
    writeFileSync(sourcePath, "x");

    const created = createAttachment(task.id, sourcePath);
    const fetched = getAttachment(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.filename).toBe("get.txt");
  });

  it("removeBoard hard-delete removes attachment rows and files", () => {
    setFlag(FF_BOARD_RM_DELETE, true);
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Delete me" });
    const sourcePath = join(sourceDir, "delete-me.txt");
    writeFileSync(sourcePath, "x");

    const attachment = createAttachment(task.id, sourcePath);
    expect(existsSync(attachment.stored_path)).toBe(true);

    removeBoard(board.slug, true);

    expect(getAttachment(attachment.id)).toBeNull();
    expect(existsSync(attachment.stored_path)).toBe(false);
  });
});
