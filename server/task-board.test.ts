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

describe("heartbeat and staleness", () => {
  beforeEach(() => board.openBoard(join(DATA, `h-${Math.random()}.db`)));

  it("bumps heartbeatAt for a running task", () => {
    const task = board.createTask({ title: "long haul" });
    board.setStatus(task.id, "ready");
    const running = board.setStatus(task.id, "running");
    const bumped = board.heartbeat(task.id);
    expect(bumped.status).toBe("running");
    expect(bumped.heartbeatAt).toBeGreaterThanOrEqual(running.heartbeatAt ?? 0);
  });

  it("refuses to heartbeat a task that isn't running", () => {
    const task = board.createTask({ title: "not started yet" });
    expect(() => board.heartbeat(task.id)).toThrow(/running/);
  });

  it("finds a running task whose heartbeat is older than the cutoff", () => {
    const task = board.createTask({ title: "flatlined" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    expect(board.staleRunning(Date.now() + 1000).map((t) => t.id)).toContain(task.id);
    expect(board.staleRunning(Date.now() - 1000).map((t) => t.id)).not.toContain(task.id);
  });

  it("excludes tasks that are not running from staleness", () => {
    const task = board.createTask({ title: "idle" });
    expect(board.staleRunning(Date.now() + 1000).map((t) => t.id)).not.toContain(task.id);
  });
});

describe("attachThread", () => {
  beforeEach(() => board.openBoard(join(DATA, `a-${Math.random()}.db`)));

  it("records the thread a running task executed in without changing its status", () => {
    const task = board.createTask({ title: "long haul" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    const withThread = board.attachThread(task.id, "thread-42");
    expect(withThread.status).toBe("running");
    expect(withThread.threadId).toBe("thread-42");
  });

  it("throws for a task that does not exist", () => {
    expect(() => board.attachThread("no-such-id", "thread-1")).toThrow(/no such task/);
  });
});

describe("patchTask", () => {
  beforeEach(() => board.openBoard(join(DATA, `p-${Math.random()}.db`)));

  it("updates only the fields given, leaving the rest untouched", () => {
    const task = board.createTask({ title: "draft", body: "first pass", priority: 0 });
    const patched = board.patchTask(task.id, { title: "final", priority: 3 });
    expect(patched.title).toBe("final");
    expect(patched.priority).toBe(3);
    expect(patched.body).toBe("first pass");
    expect(patched.status).toBe("todo");
  });

  it("assigns and then unassigns a bot, distinguishing omitted from null", () => {
    const task = board.createTask({ title: "needs an owner" });
    expect(board.patchTask(task.id, { assigneeBotId: "bot-1" }).assigneeBotId).toBe("bot-1");
    // Omitted entirely: assigneeBotId must survive untouched.
    expect(board.patchTask(task.id, { priority: 1 }).assigneeBotId).toBe("bot-1");
    // Explicit null: clears it.
    expect(board.patchTask(task.id, { assigneeBotId: null }).assigneeBotId).toBeNull();
  });

  it("throws for a task that does not exist", () => {
    expect(() => board.patchTask("no-such-id", { title: "x" })).toThrow(/no such task/);
  });
});
