import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-turn-watch-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { createTaskTurnWatch } = await import("./task-turn-watch.ts");
const { createDispatcher } = await import("./task-dispatcher.ts");

describe("task turn watch", () => {
  beforeEach(() => {
    board.openBoard(join(DATA, `w-${Math.random()}.db`));
    vi.useRealTimers();
  });

  function claim(title = "do the thing") {
    const task = board.createTask({ title, assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    return board.setStatus(task.id, "running");
  }

  it("keeps a running task alive across the stale threshold as long as its turn keeps emitting activity", async () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch();
      watch.watch(claimed.id, "thread-1");

      // Simulate the turn producing real activity every 60s (well under the
      // dispatcher's 180s staleAfterMs) for a total of 10 minutes — far past
      // the stale threshold in aggregate, but no single gap crosses it.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60_000);
        watch.handle({ type: "item.completed", threadId: "thread-1" });
      }

      const dispatch = vi.fn(async () => ({ threadId: "unused" }));
      const dispatcher = createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 });
      await dispatcher.tick();

      expect(board.getTask(claimed.id)?.status).toBe("running");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a task to review when its watched turn completes successfully", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch();
    watch.watch(claimed.id, "thread-2");

    watch.handle({ type: "item.completed", threadId: "thread-2" });
    watch.handle({ type: "turn.completed", threadId: "thread-2", ok: true });

    const after = board.getTask(claimed.id);
    expect(after?.status).toBe("review");
    expect(after?.finishedAt).toBeGreaterThan(0);
  });

  it("moves a task to blocked with the reason when its watched turn fails", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch();
    watch.watch(claimed.id, "thread-3");

    watch.handle({ type: "turn.completed", threadId: "thread-3", ok: false, stopReason: "provider quota exhausted" });

    const after = board.getTask(claimed.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blockedReason).toBe("provider quota exhausted");
  });

  it("treats a session exit with no turn.completed as a failure too", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch();
    watch.watch(claimed.id, "thread-4");

    watch.handle({ type: "session.exited", threadId: "thread-4" });

    expect(board.getTask(claimed.id)?.status).toBe("blocked");
  });

  it("a crashed turn (heartbeats simply stop arriving) is still reclaimed by the dispatcher tick", async () => {
    vi.useFakeTimers();
    try {
      const claimed = claim();
      const watch = createTaskTurnWatch();
      watch.watch(claimed.id, "thread-5");
      // One burst of real activity, then nothing ever again — the process
      // died mid-turn. No more handle() calls follow.
      watch.handle({ type: "item.started", threadId: "thread-5" });

      vi.advanceTimersByTime(181_000); // just past the default 180s stale window

      const dispatch = vi.fn(async () => ({ threadId: "thread-5-retry" }));
      const dispatcher = createDispatcher({ dispatch, now: () => Date.now(), staleAfterMs: 180_000 });
      await dispatcher.tick();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(board.getTask(claimed.id)?.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reacting to a threadId once its turn has settled — no leaked listener", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch();
    watch.watch(claimed.id, "thread-6");
    watch.handle({ type: "turn.completed", threadId: "thread-6", ok: true });
    expect(board.getTask(claimed.id)?.status).toBe("review");

    // A late duplicate event for the same (settled) thread must not throw
    // and must not move the task again.
    expect(() => watch.handle({ type: "item.completed", threadId: "thread-6" })).not.toThrow();
    expect(() => watch.handle({ type: "turn.completed", threadId: "thread-6", ok: false })).not.toThrow();
    expect(board.getTask(claimed.id)?.status).toBe("review");
  });

  it("ignores events for threads nobody is watching", () => {
    const watch = createTaskTurnWatch();
    expect(() => watch.handle({ type: "turn.completed", threadId: "stranger", ok: true })).not.toThrow();
  });

  it("stopAll forgets every watched task without settling it", () => {
    const claimed = claim();
    const watch = createTaskTurnWatch();
    watch.watch(claimed.id, "thread-7");
    watch.stopAll();
    watch.handle({ type: "turn.completed", threadId: "thread-7", ok: true });
    expect(board.getTask(claimed.id)?.status).toBe("running");
  });
});
