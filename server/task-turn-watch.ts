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
//     event stream (not a clock) is the honest signal of "still alive".
//   - settles the task the instant the turn ends: review on success,
//     blocked (with the failure recorded) otherwise.
//
// Deliberately NOT a timer. A setInterval that keeps heartbeating on a
// fixed schedule regardless of whether the turn is still producing events
// would defeat the whole point of staleRunning: a turn that silently wedges
// without ever emitting turn.completed or session.exited (the crash this
// unit is closing the gap for is exactly that — the process dies and stops
// emitting anything) must still go stale and get reclaimed. A blind timer
// tied only to "a dispatch happened" rather than to actual evidence would
// keep such a task looking alive forever, which is precisely the invariant
// server/task-dispatcher.ts's reclaim path exists to protect. So: no
// interval, no leaked timer to worry about — only a Map entry, removed the
// instant the turn settles (or a stale sweep beats us to it).
import { heartbeat, setStatus } from "./task-board.ts";

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

export interface TaskTurnWatch {
  /** Start watching a dispatched task's turn. Call once, right after the
   * turn is confirmed started — i.e. after task-board's setStatus(id,
   * "running") already ran and the caller has the threadId the turn landed
   * in. A second watch() for the same threadId replaces the first rather
   * than stacking (defensive: a reused threadId must never double-watch). */
  watch(taskId: string, threadId: string): void;
  /** Feed the watch one runtime event. Events for a threadId nobody is
   * watching are ignored — cheap enough to call unconditionally for every
   * event on the bus. */
  handle(event: TurnLifecycleEvent): void;
  /** Forget every watched task without settling them — process shutdown,
   * or a test tearing down. No timers to clear (there are none), just the
   * bookkeeping map. */
  stopAll(): void;
}

export function createTaskTurnWatch(): TaskTurnWatch {
  const watched = new Map<string, string>(); // threadId -> taskId

  function beat(taskId: string): void {
    try {
      heartbeat(taskId);
    } catch {
      // The task moved on without us — already reclaimed by a stale sweep,
      // or edited/settled by a human in the meantime. Nothing left here to
      // keep alive; the next event (if any) will find watched.has() false
      // once settle() below has run, or just keep harmlessly no-op'ing.
    }
  }

  function watch(taskId: string, threadId: string): void {
    watched.set(threadId, taskId);
    // The claim that led here already stamped heartbeat_at (task-board.ts's
    // setStatus(..., "running")), but beating again here costs nothing and
    // covers the gap between that claim and the turn's first real event.
    beat(taskId);
  }

  function settle(threadId: string, ok: boolean, reason: string | undefined): void {
    const taskId = watched.get(threadId);
    if (!taskId) return;
    watched.delete(threadId);
    try {
      if (ok) setStatus(taskId, "review");
      else setStatus(taskId, "blocked", { blockedReason: reason ?? "the turn did not finish" });
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
    const taskId = watched.get(event.threadId);
    if (!taskId) return;
    if (event.type === "turn.completed") {
      const ok = event.ok === true;
      settle(event.threadId, ok, ok ? undefined : (event.stopReason?.trim() || "the bot's turn ended without success"));
      return;
    }
    if (event.type === "session.exited") {
      // A driver can exit without ever emitting turn.completed (the same
      // reason server/index.ts's memory-journal subscriber folds on both
      // events) — treat it as a failure rather than leaving the task
      // watched forever with no more evidence ever coming.
      settle(event.threadId, false, "the bot's session exited before the turn finished");
      return;
    }
    beat(taskId);
  }

  function stopAll(): void {
    watched.clear();
  }

  return { watch, handle, stopAll };
}
