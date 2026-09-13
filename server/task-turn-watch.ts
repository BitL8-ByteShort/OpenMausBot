// The last gap in the board's crash-recovery core: task-dispatcher.ts
// promotes, claims, reclaims, and gives up, but nothing ever heartbeats a
// dispatched task while its turn runs, and nothing settles it when the turn
// ends. Left alone, a dispatched task whose turn SUCCEEDS still goes cold
// under staleRunning, gets reclaimed, retried, and eventually blocked —
// exactly as if it had crashed.
//
// This module is the observer that closes that gap. It watches a
// dispatched task's turn on the harness's own runtime event stream
// (server/index.ts's `bus`, RuntimeEvent from contracts.ts) and:
//   - heartbeats the task on every sign the turn is still doing something —
//     item.started/completed, content.delta, thread.token-usage.updated,
//     turn.retrying, request.opened/resolved, session.started all only fire
//     while a real turn is actually producing something, which is why the
//     event stream is the PRIMARY, honest signal of "still alive".
//   - backs that up with a low-frequency keepalive while a turn is in
//     flight, for the case a turn is genuinely alive but quiet for longer
//     than the event stream happens to promise (one long tool call with no
//     intervening progress event). Round 1 of this module shipped
//     event-driven heartbeats only and reasoned that any timer was
//     dishonest; that missed the actual failure mode: a turn that is
//     merely QUIET is not the same as a turn that is DEAD, and treating
//     silence as death reclaims and re-dispatches live work, running it
//     twice — the exact thing the board exists to prevent. The keepalive
//     here is still honest evidence, not a blind timer: it exists, and
//     keeps ticking, only because a turn was confirmed to have actually
//     started IN THIS PROCESS, and it is torn down in the same instant the
//     turn settles or the watch is stopped. If the process dies, the timer
//     dies with it — nothing survives a crash, so the crash path (nobody
//     left to heartbeat, event-driven or otherwise) still works exactly as
//     before. It never outlives the turn (cleared at settle()) or the
//     process (a bare setInterval, unref()'d so it cannot itself keep the
//     process alive).
//   - settles the task the instant the turn ends: review on success,
//     blocked (with the failure recorded) otherwise.
//
// What is unchanged, deliberately: task-board.ts's TRANSITIONS and
// task-dispatcher.ts's staleRunning/reclaim/give-up/promote/claim ordering.
// This module only ever calls the existing heartbeat()/setStatus() — it is
// a client of the safety net, never a change to it.
import { heartbeat, setStatus } from "./task-board.ts";
import { DEFAULT_STALE_AFTER_MS } from "./task-dispatcher.ts";

/** The slice of RuntimeEvent this module reacts to. Kept narrow (rather
 * than importing the full RuntimeEvent union from contracts.ts) so tests
 * can construct fixtures without every field a real provider event carries
 * — a real RuntimeEvent satisfies this shape structurally, so the harness
 * can pass one straight through with no adapter. */
export interface TurnLifecycleEvent {
  type: string;
  threadId: string;
  /** Present (and meaningful) only on "turn.completed". */
  ok?: boolean;
  /** Present (and meaningful) only on "turn.completed". */
  stopReason?: string | null;
}

export interface TaskTurnWatchOptions {
  /** The stale threshold this watch is protecting a quiet-but-live turn
   * against. The keepalive ticks at a fraction of it (see keepaliveMs
   * below). Defaults to task-dispatcher.ts's own DEFAULT_STALE_AFTER_MS so
   * the two stay in sync without every call site repeating the number —
   * pass the dispatcher's actual configured value here if it was
   * overridden, or the keepalive's margin against the real stale cutoff
   * shrinks or grows out of step with it. */
  staleAfterMs?: number;
}

export interface TaskTurnWatch {
  /** Start watching a dispatched task's turn. Call once, right after the
   * turn is confirmed started — i.e. after task-board's setStatus(id,
   * "running") already ran and the caller has the threadId the turn landed
   * in. Starts the keepalive for this thread. A second watch() for the
   * same threadId replaces the first rather than stacking (defensive: a
   * reused threadId must never double-watch, and must never leak the
   * first watch's timer). */
  watch(taskId: string, threadId: string): void;
  /** Feed the watch one runtime event. Events for a threadId nobody is
   * watching are ignored — cheap enough to call unconditionally for every
   * event on the bus. */
  handle(event: TurnLifecycleEvent): void;
  /** Stop every keepalive timer and forget every watched task, without
   * settling any of them — process shutdown, or a test standing in for
   * "the process died mid-turn". */
  stopAll(): void;
}

interface Watched {
  taskId: string;
  keepalive: ReturnType<typeof setInterval>;
}

export function createTaskTurnWatch(options: TaskTurnWatchOptions = {}): TaskTurnWatch {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // A third of the stale threshold: comfortably often enough that a quiet
  // (but alive) turn's heartbeat is never more than one keepalive tick
  // away from fresh, with margin against a busy event loop delaying a
  // given tick. Never below a 1s floor even if staleAfterMs is configured
  // absurdly small (a test, say) — a zero or negative interval would spin.
  const keepaliveMs = Math.max(1000, Math.floor(staleAfterMs / 3));
  const watched = new Map<string, Watched>(); // threadId -> { taskId, keepalive }

  function beat(taskId: string): void {
    try {
      heartbeat(taskId);
    } catch {
      // The task moved on without us — already reclaimed by a stale sweep,
      // or edited/settled by a human in the meantime. Nothing left here to
      // keep alive.
    }
  }

  function stop(threadId: string): void {
    const entry = watched.get(threadId);
    if (!entry) return;
    clearInterval(entry.keepalive);
    watched.delete(threadId);
  }

  function watch(taskId: string, threadId: string): void {
    stop(threadId); // defensive: a reused threadId must never double-watch
    // The claim that led here already stamped heartbeat_at (task-board.ts's
    // setStatus(..., "running")), but beating again here costs nothing and
    // covers the gap between that claim and the turn's first real event or
    // keepalive tick.
    beat(taskId);
    const keepalive = setInterval(() => beat(taskId), keepaliveMs);
    keepalive.unref?.();
    watched.set(threadId, { taskId, keepalive });
  }

  function settle(threadId: string, ok: boolean, reason: string | undefined): void {
    const entry = watched.get(threadId);
    if (!entry) return;
    stop(threadId); // the keepalive must not outlive the turn it was covering
    try {
      if (ok) setStatus(entry.taskId, "review");
      else setStatus(entry.taskId, "blocked", { blockedReason: reason ?? "the turn did not finish" });
    } catch {
      // Already moved on: reclaimed and re-dispatched under a fresh
      // attempt (a new threadId, so this stale terminal signal belongs to
      // an attempt the board has already superseded), or a human already
      // touched the task's status. Either way this terminal signal arrived
      // too late to matter — never force a transition just because we
      // remembered a threadId no one asked us to forget.
    }
  }

  function handle(event: TurnLifecycleEvent): void {
    const entry = watched.get(event.threadId);
    if (!entry) return;
    if (event.type === "turn.completed") {
      const ok = event.ok === true;
      settle(event.threadId, ok, ok ? undefined : (event.stopReason?.trim() || "the bot's turn ended without success"));
      return;
    }
    if (event.type === "session.exited") {
      // A driver can exit without ever emitting turn.completed (the same
      // reason server/index.ts's memory-journal subscriber folds on both
      // events) — treat it as a failure rather than leaving the task
      // watched (and its keepalive ticking) forever with no more evidence
      // ever coming.
      settle(event.threadId, false, "the bot's session exited before the turn finished");
      return;
    }
    beat(entry.taskId);
  }

  function stopAll(): void {
    // Deleting the current key mid-iteration over a Map is well-defined
    // (and does not skip the next one), so no need to snapshot the keys.
    for (const threadId of watched.keys()) stop(threadId);
  }

  return { watch, handle, stopAll };
}
