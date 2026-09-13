import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA = mkdtempSync(join(tmpdir(), "omb-tick-"));
vi.mock("./config.ts", () => ({ DATA_DIR: DATA }));

const board = await import("./task-board.ts");
const { createDispatcher } = await import("./task-dispatcher.ts");

describe("the dispatcher tick", () => {
  beforeEach(() => board.openBoard(join(DATA, `d-${Math.random()}.db`)));

  it("promotes, claims, and records the thread it ran in", async () => {
    const task = board.createTask({ title: "do the thing", assigneeBotId: "bot-1" });
    const dispatch = vi.fn(async () => ({ threadId: "thread-7" }));
    await createDispatcher({ dispatch }).tick();

    const after = board.getTask(task.id);
    expect(after?.status).toBe("running");
    expect(after?.threadId).toBe("thread-7");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("honours the concurrency cap", async () => {
    for (let i = 0; i < 5; i++) board.createTask({ title: `t${i}`, assigneeBotId: "bot-1" });
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxRunning: 2 }).tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not claim a task whose parents are unfinished", async () => {
    const parent = board.createTask({ title: "first" });
    board.createTask({ title: "second", parentIds: [parent.id] });
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxRunning: 10 }).tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reclaims a running task whose heartbeat went cold", async () => {
    const task = board.createTask({ title: "crashed", assigneeBotId: "bot-1" });
    board.setStatus(task.id, "ready");
    board.setStatus(task.id, "running");
    const clock = Date.now() + 10 * 60_000;
    const dispatch = vi.fn(async () => ({ threadId: "t2" }));
    await createDispatcher({ dispatch, now: () => clock, staleAfterMs: 60_000 }).tick();
    expect(board.getTask(task.id)?.attempts).toBe(2);
  });

  it("blocks a task that has burned through its attempts instead of looping", async () => {
    const task = board.createTask({ title: "cursed", assigneeBotId: "bot-1" });
    for (let i = 0; i < 3; i++) {
      board.setStatus(task.id, "ready");
      board.setStatus(task.id, "running");
    }
    // Reclaimed after its 3rd failed attempt — back in "ready" with
    // attempts already at the cap, which is where give-up must catch it:
    // before a 4th claim, not while it is mid-flight (see the next test).
    board.setStatus(task.id, "ready");
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxAttempts: 3 }).tick();
    expect(board.getTask(task.id)?.status).toBe("blocked");
    expect(board.getTask(task.id)?.blockedReason).toMatch(/3 attempts/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not force-block a running task whose attempt count already sits at the cap, as long as it is still heartbeating", async () => {
    // A task on its 3rd (final) attempt is legitimately running right now —
    // it has not failed yet, it might still succeed. Give-up must judge a
    // task by whether it is back in the pool asking for another attempt,
    // not by a historical attempt count that a healthy in-flight task also
    // happens to carry.
    const task = board.createTask({ title: "still going", assigneeBotId: "bot-1" });
    for (let i = 0; i < 3; i++) {
      board.setStatus(task.id, "ready");
      board.setStatus(task.id, "running");
    }
    board.heartbeat(task.id);
    const dispatch = vi.fn(async () => ({ threadId: "t" }));
    await createDispatcher({ dispatch, maxAttempts: 3 }).tick();
    const after = board.getTask(task.id);
    expect(after?.status).toBe("running");
    expect(after?.blockedReason).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a task to ready when dispatch declines it", async () => {
    const task = board.createTask({ title: "busy bot", assigneeBotId: "bot-1" });
    await createDispatcher({ dispatch: async () => null }).tick();
    expect(board.getTask(task.id)?.status).toBe("ready");
  });

  it("never lets a second tick double-claim while the first is still dispatching", async () => {
    board.createTask({ title: "slow one", assigneeBotId: "bot-1" });
    const box: { resolve: (() => void) | null } = { resolve: null };
    const dispatch = vi.fn(
      () =>
        new Promise<{ threadId: string } | null>((resolve) => {
          box.resolve = () => resolve({ threadId: "t" });
        }),
    );
    const dispatcher = createDispatcher({ dispatch, maxRunning: 10 });
    const first = dispatcher.tick();
    const second = dispatcher.tick();
    box.resolve?.();
    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
