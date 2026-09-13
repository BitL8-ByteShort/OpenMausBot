// The tick that turns board storage (task-board.ts) into a working
// queue. It owns no state of its own beyond the interval timer and the
// re-entrancy guard below — every decision reads and writes through the
// board's state machine, so a restart loses nothing but the timer.
//
// Order inside one tick is the whole design: reclaim -> give up ->
// promote -> claim.
//   - Reclaiming first means a task whose bot died is back in the pool
//     within the same tick, before the concurrency cap is measured.
//   - Giving up before promoting means a cursed task (one that keeps
//     killing its bot) cannot consume a claim slot every tick forever —
//     it is blocked before promotion and claim even look at it.
//   - Promoting before claiming means a todo task that just became
//     eligible this tick (its last parent finished) can be claimed in
//     the same pass, rather than waiting a full TICK_MS.
import { type BoardTask, attachThread, listTasks, promotable, setStatus, staleRunning } from "./task-board.ts";

export const TICK_MS = 30_000;
export const DEFAULT_STALE_AFTER_MS = 180_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface DispatcherOptions {
  /** Injectable clock so tests never sleep for real. */
  now?: () => number;
  /** Hand a claimed task to the turn machinery. Resolves when the turn
   * has been STARTED, not when it finishes — the board tracks the rest
   * through heartbeats and the completion callback. Returning null means
   * the assignee could not take the task right now (e.g. busy elsewhere);
   * the task goes back to ready without burning a concurrency slot. */
  dispatch: (task: BoardTask) => Promise<{ threadId: string } | null>;
  /** Concurrency cap across the whole board. P1 replaces this with a
   * budget-derived number; until then it is config with a default of 2. */
  maxRunning?: number;
  /** A running task whose last heartbeat is older than this is assumed
   * dead and returned to ready. */
  staleAfterMs?: number;
  /** Give up on a task that has been claimed this many times. */
  maxAttempts?: number;
  emit?: (payload: { kind: string; task: BoardTask }) => void;
}

export interface Dispatcher {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxRunning = options.maxRunning ?? 2;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function tick(): Promise<void> {
    // A slow dispatch (an in-flight await options.dispatch(...)) must
    // never let a second tick double-claim the rest of the board.
    if (ticking) return;
    ticking = true;
    try {
      // reclaim: a running task whose heartbeat has gone cold is back in
      // the pool before anything below measures the concurrency cap.
      for (const dead of staleRunning(now() - staleAfterMs)) {
        const reclaimed = setStatus(dead.id, "ready");
        options.emit?.({ kind: "board.reclaimed", task: reclaimed });
      }

      // give up: a task keeps its attempt count from every claim,
      // including a reclaim (task-board.ts bumps it on every entry to
      // "running"). Once that count hits the cap the task is blocked
      // outright rather than being handed back into the pool to loop
      // again — this checks both "ready" (about to be reclaimed into
      // another attempt) and "running" (already at the cap, e.g. because
      // maxAttempts was lowered, or a caller outside this tick claimed
      // it directly) since TRANSITIONS legally allows blocked from
      // either state.
      for (const task of listTasks({ status: ["ready", "running"] })) {
        if (task.attempts < maxAttempts) continue;
        const given = setStatus(task.id, "blocked", {
          blockedReason: `gave up after ${task.attempts} attempts — no progress`,
        });
        options.emit?.({ kind: "board.gave-up", task: given });
      }

      // promote: todo tasks with nothing left to wait for join the pool,
      // in the same tick that made them eligible.
      for (const task of promotable()) {
        const ready = setStatus(task.id, "ready");
        options.emit?.({ kind: "board.promoted", task: ready });
      }

      // claim: hand ready tasks to the turn machinery up to the cap.
      let slots = maxRunning - listTasks({ status: ["running"] }).length;
      for (const task of listTasks({ status: ["ready"] })) {
        if (slots <= 0) break;
        // Defense in depth: give-up above should already have blocked
        // anything at the cap, but a task promoted moments ago in this
        // same tick never had attempts near the cap anyway, so this is
        // just a belt-and-braces guard against claiming a cursed task.
        if (task.attempts >= maxAttempts) continue;
        const claimed = setStatus(task.id, "running");
        const started = await options.dispatch(claimed);
        if (!started) {
          // The assignee could not take it right now (e.g. busy
          // elsewhere). Put it back without burning a concurrency slot —
          // the claim itself still counted as an attempt.
          setStatus(task.id, "ready");
          continue;
        }
        slots -= 1;
        const withThread = attachThread(claimed.id, started.threadId);
        options.emit?.({ kind: "board.claimed", task: withThread });
      }
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
