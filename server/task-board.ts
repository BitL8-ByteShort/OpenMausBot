// A durable work queue for the fleet.
//
// delegate_bot hands one message to one peer and forgets it; a routine
// re-runs a prompt on a clock. Neither can express "this piece of work
// exists, it is not done, someone should pick it up, and it is still
// true after a restart". That is what this table is.
//
// node:sqlite for the same reason message-db.ts uses it: built into
// Node >= 23.4, so the packaged app gains no native dependency.
//
// Scope: this module owns the table set, the status state machine,
// dependency links, and comments — claim/heartbeat/reclaim as far as they
// are storage primitives on a task row. It does no dispatching and knows
// nothing about HTTP; the tick that decides what to promote, claim, or
// reclaim is a separate module built on top of this one.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type BoardStatus = "todo" | "ready" | "running" | "blocked" | "review" | "done" | "archived";

export interface BoardTask {
  id: string;
  title: string;
  body: string;
  status: BoardStatus;
  assigneeBotId: string | null;
  createdByBotId: string | null;
  priority: number; // 0 = normal, higher runs first
  threadId: string | null; // the turn this task ran in, once it has run
  result: string | null;
  blockedReason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
}

export interface BoardComment {
  id: number;
  taskId: string;
  botId: string | null;
  text: string;
  at: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assigneeBotId?: string | null;
  createdByBotId?: string | null;
  priority?: number;
  parentIds?: string[];
}

export interface StatusPatch {
  result?: string;
  blockedReason?: string;
  threadId?: string;
}

/** The only legal moves. Everything else throws, including the ones that
 * look harmless — "done → running" would silently re-run accepted work. */
const TRANSITIONS: Record<BoardStatus, BoardStatus[]> = {
  todo: ["ready", "archived"],
  ready: ["running", "blocked", "archived"],
  running: ["review", "blocked", "ready"],
  blocked: ["ready", "archived"],
  review: ["done", "ready", "archived"],
  done: ["archived"],
  archived: [],
};

let db: DatabaseSync | null = null;
let file = "";

export function boardFile(): string {
  return file;
}

/** The live handle. Every other function in this module goes through this
 * so a missing openBoard() call fails loudly instead of touching nothing. */
function handle(): DatabaseSync {
  if (!db) throw new Error("task board not open — call openBoard() first");
  return db;
}

export function openBoard(path: string = join(DATA_DIR, "tasks.db")): void {
  try {
    db?.close();
  } catch {
    // already closed, or the underlying file is gone — nothing to do
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Task titles and bodies carry whatever the user or a bot typed. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask — the same approach
  // message-db.ts uses for messages.db.
  closeSync(openSync(path, "a", 0o600));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort repair; a read-only filesystem should not block opening
  }
  db = new DatabaseSync(path);
  file = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      assignee_bot_id TEXT,
      created_by_bot_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      result TEXT,
      blocked_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_links (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      bot_id TEXT,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, priority DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS task_links_child ON task_links (child_id);
    CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments (task_id, id);
  `);
}

interface TaskRow {
  id: string;
  title: string;
  body: string;
  status: BoardStatus;
  assignee_bot_id: string | null;
  created_by_bot_id: string | null;
  priority: number;
  thread_id: string | null;
  result: string | null;
  blocked_reason: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
}

function rowToTask(row: TaskRow): BoardTask {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    assigneeBotId: row.assignee_bot_id,
    createdByBotId: row.created_by_bot_id,
    priority: row.priority,
    threadId: row.thread_id,
    result: row.result,
    blockedReason: row.blocked_reason,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
  };
}

export function createTask(input: CreateTaskInput): BoardTask {
  const id = newId();
  const now = Date.now();
  handle()
    .prepare(`
      INSERT INTO tasks (
        id, title, body, status, assignee_bot_id, created_by_bot_id,
        priority, thread_id, result, blocked_reason, attempts,
        created_at, updated_at, started_at, heartbeat_at, finished_at
      ) VALUES (?, ?, ?, 'todo', ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, NULL)
    `)
    .run(
      id,
      input.title,
      input.body ?? "",
      input.assigneeBotId ?? null,
      input.createdByBotId ?? null,
      input.priority ?? 0,
      now,
      now,
    );
  for (const parentId of input.parentIds ?? []) linkTasks(parentId, id);
  const created = getTask(id);
  if (!created) throw new Error(`task vanished right after creation: ${id}`);
  return created;
}

export function getTask(id: string): BoardTask | null {
  const row = handle().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(filter: { status?: BoardStatus[]; assigneeBotId?: string } = {}): BoardTask[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.assigneeBotId !== undefined) {
    clauses.push("assignee_bot_id = ?");
    params.push(filter.assigneeBotId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = handle()
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC`)
    .all(...params) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function setStatus(id: string, next: BoardStatus, patch: StatusPatch = {}): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (!TRANSITIONS[task.status].includes(next)) {
    throw new Error(`illegal transition ${task.status} → ${next}`);
  }
  const now = Date.now();
  // Every claim is an attempt, including a reclaim after a dead heartbeat.
  // Without this a bot that crashes on one task retries it forever.
  const attempts = next === "running" ? task.attempts + 1 : task.attempts;
  handle()
    .prepare(`
      UPDATE tasks SET
        status = ?, attempts = ?, updated_at = ?,
        started_at   = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
        heartbeat_at = CASE WHEN ? = 'running' THEN ? ELSE heartbeat_at END,
        finished_at  = CASE WHEN ? IN ('review','done') THEN ? ELSE finished_at END,
        thread_id      = COALESCE(?, thread_id),
        result         = COALESCE(?, result),
        blocked_reason = CASE WHEN ? = 'blocked' THEN ? ELSE NULL END
      WHERE id = ?
    `)
    .run(
      next,
      attempts,
      now,
      next,
      now,
      next,
      now,
      next,
      now,
      patch.threadId ?? null,
      patch.result ?? null,
      next,
      patch.blockedReason ?? null,
      id,
    );
  const updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  return updated;
}

/** todo tasks with nothing left to wait for. An archived parent counts as
 * satisfied: abandoning a branch must not wedge everything downstream of
 * it, which is the failure mode of treating archive as "still pending". */
export function promotable(): BoardTask[] {
  const rows = handle()
    .prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'todo'
        AND NOT EXISTS (
          SELECT 1 FROM task_links l
          JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = t.id AND p.status NOT IN ('done', 'archived')
        )
      ORDER BY t.priority DESC, t.created_at ASC
    `)
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function linkTasks(parentId: string, childId: string): void {
  handle()
    .prepare("INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)")
    .run(parentId, childId);
}

export function parentsOf(id: string): BoardTask[] {
  const rows = handle()
    .prepare(`
      SELECT p.* FROM tasks p
      JOIN task_links l ON l.parent_id = p.id
      WHERE l.child_id = ?
    `)
    .all(id) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

interface CommentRow {
  id: number;
  task_id: string;
  bot_id: string | null;
  text: string;
  at: number;
}

function rowToComment(row: CommentRow): BoardComment {
  return { id: row.id, taskId: row.task_id, botId: row.bot_id, text: row.text, at: row.at };
}

export function addComment(taskId: string, botId: string | null, text: string): BoardComment {
  const at = Date.now();
  const result = handle()
    .prepare("INSERT INTO task_comments (task_id, bot_id, text, at) VALUES (?, ?, ?, ?)")
    .run(taskId, botId, text, at);
  return { id: Number(result.lastInsertRowid), taskId, botId, text, at };
}

export function commentsOf(taskId: string): BoardComment[] {
  const rows = handle()
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id ASC")
    .all(taskId) as unknown as CommentRow[];
  return rows.map(rowToComment);
}
