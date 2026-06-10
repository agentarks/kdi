import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import { addComment, getComments, type Comment } from "../src/models/comment";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-comment-test.db";

describe("comment model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("addComment returns comment with id, task_id, text, created_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment(task.id, "First comment");

    expect(comment.id).toBeNumber();
    expect(comment.task_id).toBe(task.id);
    expect(comment.text).toBe("First comment");
    expect(comment.created_at).toBeNumber();
  });

  it("getComments returns comments ordered by created_at ASC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment1 = addComment(task.id, "First");
    const comment2 = addComment(task.id, "Second");

    const comments = getComments(task.id);

    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe(comment1.id);
    expect(comments[0].text).toBe("First");
    expect(comments[1].id).toBe(comment2.id);
    expect(comments[1].text).toBe("Second");
  });

  it("getComments returns empty array when no comments", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comments = getComments(task.id);

    expect(comments).toHaveLength(0);
  });

  it("addComment handles empty string text", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment(task.id, "");

    expect(comment.text).toBe("");
    const comments = getComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("");
  });

  it("addComment handles non-existent taskId", () => {
    const comment = addComment(99999, "Orphan comment");

    expect(comment.id).toBeNumber();
    expect(comment.task_id).toBe(99999);
    const comments = getComments(99999);
    expect(comments).toHaveLength(1);
  });

  it("getComments isolates comments by task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const taskA = createTask({ board_id: board.id, title: "Task A" });
    const taskB = createTask({ board_id: board.id, title: "Task B" });

    addComment(taskA.id, "Comment for A");
    addComment(taskB.id, "Comment for B");

    const commentsA = getComments(taskA.id);
    const commentsB = getComments(taskB.id);

    expect(commentsA).toHaveLength(1);
    expect(commentsA[0].text).toBe("Comment for A");
    expect(commentsB).toHaveLength(1);
    expect(commentsB[0].text).toBe("Comment for B");
  });

  it("addComment handles special characters and quotes in text", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const specialText = `Hello "world" & 'test' <script>alert(1)</script> -- ; DROP TABLE comments;`;
    const comment = addComment(task.id, specialText);

    expect(comment.text).toBe(specialText);
    const comments = getComments(task.id);
    expect(comments[0].text).toBe(specialText);
  });
});
