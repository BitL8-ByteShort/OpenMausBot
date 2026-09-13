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
