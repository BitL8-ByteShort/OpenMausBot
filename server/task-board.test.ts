import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-board-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");

describe("the board", () => {
  beforeEach(() => board.openBoard(join(DATA, `board-${Math.random()}.db`)));

  it("creates a task in todo and writes 0600", () => {
    const task = board.createTask({ title: "Write the changelog" });
    expect(task.status).toBe("todo");
    expect(task.attempts).toBe(0);
    expect(statSync(board.boardFile()).mode & 0o777).toBe(0o600);
  });

  it("survives a reopen", () => {
    const file = join(DATA, "persist.db");
    board.openBoard(file);
    const created = board.createTask({ title: "Outlive the process" });
    board.openBoard(file);
    expect(board.getTask(created.id)?.title).toBe("Outlive the process");
  });

  it("lists newest-first within a priority", () => {
    board.createTask({ title: "low" });
    board.createTask({ title: "high", priority: 5 });
    expect(board.listTasks().map((t) => t.title)).toEqual(["high", "low"]);
  });
});

describe("transitions", () => {
  beforeEach(() => board.openBoard(join(DATA, `t-${Math.random()}.db`)));

  it("walks the happy path and stamps the clocks", () => {
    const task = board.createTask({ title: "ship it" });
    expect(board.setStatus(task.id, "ready").status).toBe("ready");
    const running = board.setStatus(task.id, "running", { threadId: "thread-9" });
    expect(running.startedAt).toBeGreaterThan(0);
    expect(running.threadId).toBe("thread-9");
    expect(running.attempts).toBe(1);
    const reviewed = board.setStatus(task.id, "review", { result: "shipped" });
    expect(reviewed.finishedAt).toBeGreaterThan(0);
    expect(board.setStatus(task.id, "done").status).toBe("done");
  });

  it("refuses an illegal move", () => {
    const task = board.createTask({ title: "no shortcuts" });
    expect(() => board.setStatus(task.id, "running")).toThrow(/todo → running/);
    expect(() => board.setStatus(task.id, "done")).toThrow(/todo → done/);
  });

  it("counts an attempt per claim, so a reclaimed task cannot loop forever", () => {
    const task = board.createTask({ title: "flaky" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    board.setStatus(task.id, "ready"); // reclaimed
    expect(board.setStatus(task.id, "running").attempts).toBe(2);
  });

  it("records a block reason and clears it on the way out", () => {
    const task = board.createTask({ title: "needs a key" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    expect(board.setStatus(task.id, "blocked", { blockedReason: "no GitHub token" }).blockedReason)
      .toBe("no GitHub token");
    expect(board.setStatus(task.id, "ready").blockedReason).toBeNull();
  });
});

describe("links", () => {
  beforeEach(() => board.openBoard(join(DATA, `l-${Math.random()}.db`)));

  it("reports a child as not promotable until every parent is done", () => {
    const a = board.createTask({ title: "design" });
    const b = board.createTask({ title: "build" });
    const child = board.createTask({ title: "ship", parentIds: [a.id, b.id] });
    expect(board.parentsOf(child.id).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(board.promotable().map((t) => t.id)).not.toContain(child.id);

    for (const parent of [a, b]) {
      board.setStatus(parent.id, "ready");
      board.setStatus(parent.id, "running");
      board.setStatus(parent.id, "review");
      board.setStatus(parent.id, "done");
    }
    expect(board.promotable().map((t) => t.id)).toContain(child.id);
  });

  it("treats an archived parent as satisfied, so an abandoned branch cannot wedge the board", () => {
    const parent = board.createTask({ title: "abandoned" });
    const child = board.createTask({ title: "downstream", parentIds: [parent.id] });
    board.setStatus(parent.id, "archived");
    expect(board.promotable().map((t) => t.id)).toContain(child.id);
  });
});

describe("comments", () => {
  beforeEach(() => board.openBoard(join(DATA, `c-${Math.random()}.db`)));

  it("keeps comments oldest-first and attributes the author", () => {
    const task = board.createTask({ title: "discuss" });
    board.addComment(task.id, "bot-1", "starting on this");
    board.addComment(task.id, null, "hold off until Friday");
    expect(board.commentsOf(task.id).map((c) => c.botId)).toEqual(["bot-1", null]);
  });
});
