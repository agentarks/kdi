import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import { addComment, getComments, type Comment } from "../src/models/comment";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-comment-test.db";

describe("comment model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("addComment returns comment with id, task_id, text, author, created_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "First comment" });

    expect(comment.id).toBeNumber();
    expect(comment.task_id).toBe(task.id);
    expect(comment.text).toBe("First comment");
    expect(comment.author).toBe("user");
    expect(comment.created_at).toBeNumber();
  });

  it("addComment stores explicit author", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "Hello", author: "alice" });
    expect(comment.author).toBe("alice");

    const persisted = getComments(task.id)[0];
    expect(persisted.author).toBe("alice");
  });

  it("addComment defaults author to 'user' when not provided", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "No author" });
    expect(comment.author).toBe("user");
  });

  it("addComment rejects empty author", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    expect(() => addComment({ task_id: task.id, text: "Bad", author: "" }))
      .toThrow("Author cannot be empty.");
    expect(() => addComment({ task_id: task.id, text: "Bad", author: "   " }))
      .toThrow("Author cannot be empty.");
  });

  it("addComment trims text to max_len when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "hello world", max_len: 5 });
    expect(comment.text).toBe("hello");
  });

  it("addComment stores full text when max_len exceeds text length", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "hi", max_len: 100 });
    expect(comment.text).toBe("hi");
  });

  it("addComment stores full text when max_len is omitted", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment = addComment({ task_id: task.id, text: "hello world" });
    expect(comment.text).toBe("hello world");
  });

  it("getComments returns comments ordered by created_at ASC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    const comment1 = addComment({ task_id: task.id, text: "First" });
    const comment2 = addComment({ task_id: task.id, text: "Second" });

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

    const comment = addComment({ task_id: task.id, text: "" });

    expect(comment.text).toBe("");
    const comments = getComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("");
  });

  it("addComment handles non-existent taskId", () => {
    const comment = addComment({ task_id: 99999, text: "Orphan comment" });

    expect(comment.id).toBeNumber();
    expect(comment.task_id).toBe(99999);
    const comments = getComments(99999);
    expect(comments).toHaveLength(1);
  });

  it("getComments isolates comments by task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const taskA = createTask({ board_id: board.id, title: "Task A" });
    const taskB = createTask({ board_id: board.id, title: "Task B" });

    addComment({ task_id: taskA.id, text: "Comment for A" });
    addComment({ task_id: taskB.id, text: "Comment for B" });

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
    const comment = addComment({ task_id: task.id, text: specialText });

    expect(comment.text).toBe(specialText);
    const comments = getComments(task.id);
    expect(comments[0].text).toBe(specialText);
  });

  it("getComments returns author for persisted comment", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    addComment({ task_id: task.id, text: "Hello", author: "bob" });

    const comments = getComments(task.id);
    expect(comments[0].author).toBe("bob");
  });

  it("getComments returns null author for legacy comments without author", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Task 1" });

    // Insert directly without author to simulate legacy comment
    const db = getDb();
    db.run("INSERT INTO comments (task_id, text) VALUES (?, ?)", [task.id, "Legacy"]);

    const comments = getComments(task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("Legacy");
    expect(comments[0].author).toBeNull();
  });
});
