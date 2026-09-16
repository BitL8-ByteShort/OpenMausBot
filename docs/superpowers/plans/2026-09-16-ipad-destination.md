# iPad Destination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iPad a per-bot computer destination beside Browser, Local VM and Cloud, with tools mounted every turn, a live mirror in the Computer panel, and a way to start WebDriverAgent from the app in a dev tree.

**Architecture:** `ipad` becomes a first-class Surface on the server (resolver, store, prompt, overview, dispatch branch) and in the renderer (place, chip, panel tile, tab). A new `server/ipad-device.ts` reuses the WDA client from the proxy for session-less status and screenshot calls, manages a launcher child, and answers four `/api/ipad/*` routes; a new `IpadDevicePanel` polls those routes for the mirror. The per-message trigger path from the harness spec stays for bots on Auto.

**Tech Stack:** TypeScript on Node (server) and React 18 + lucide-react (renderer), vitest, hand-rolled HTTP routing in `server/index.ts`, WebDriverAgent HTTP API.

**Spec:** `docs/superpowers/specs/2026-09-16-ipad-destination-design.md`

## Global Constraints

- Surface value is the literal string `"ipad"` everywhere: server, store, renderer, locale keys (`place.ipad`, `vm.dest.ipad`, `computer.dest.ipadDesc`, `computer.tab.ipad`, `computer.ipad.*`).
- `server/ipad-device.ts` uses only session-less WDA routes: `GET /status` and `GET /screenshot`. It must never create a WDA session.
- Frames are cached for exactly one second. The mirror polls every two seconds while visible and pauses when hidden.
- `startable` is true only when `<SERVER_ROOT>/../scripts/ipad-wda.mjs` exists (dev tree). The packaged app reports `startable: false` and the manual instruction.
- Route statuses: `GET /api/ipad/frame` → 503 when unreachable; `POST /api/ipad/start` → 409 when running, 501 when not startable; `POST /api/ipad/stop` → 200 always.
- Turn resource name `computer:ipad`; error text "another thread is using the iPad — wait for it to finish".
- Prompt paragraph text is copied verbatim from the spec (Task 1).
- Labels: "iPad" (chip, tile, tab), "the iPad" (surface label), "Computer preference: the iPad." (overview).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests: `pnpm exec vitest run <file>`; type-check: `pnpm exec tsc -p tsconfig.server.json --noEmit` for server files and `pnpm exec tsc -p tsconfig.json --noEmit` for renderer files.
- Work in `/Users/omkar/Desktop/openmaus/OpenGrokBot-ipad` on `feat/ipad-harness`. Never push or open a PR.

## File map

| File | Responsibility |
| --- | --- |
| `server/surface.ts` (modify) | `ipad` in Surface, ComputerWant, SURFACES, `surfaceLabel`, `surfaceOfComputerKind`. |
| `server/store.ts:660` (modify) | Bot `computer` union. |
| `server/bot-overview.ts:198-212` (modify) | Overview line. |
| `server/system-prompt.ts:44-76` (modify) | Prompt kind and paragraph. |
| `shared/tool-surface.ts` (modify) | `mcp__ipad__*` counts as a computer tool. |
| `server/ipad-device.ts` (create) | WDA status/frame with cache, launcher child, route handler, preview capture. |
| `server/index.ts` (modify) | PATCH validation list, `/api/ipad/*` delegation, dispatch branch, prompt-kind mapping, trigger-mount computerKind, channel refusal list. |
| `src/lib/place.ts`, `src/lib/computer-panel-view.ts`, `src/state/store.tsx:275,349`, `src/components/PlaceIcon.tsx`, `src/components/PlaceChip.tsx`, `src/components/LocalComputerSection.tsx:125-129` (modify) | Renderer place model and labels. |
| `src/lib/ipad-place.ts` (create) + test | Pure tile/tab state from a status object. |
| `src/components/IpadDevicePanel.tsx` (create) | Status hook, mirror, Start/Stop. |
| `src/components/ComputerPanel.tsx` (modify) | Tile, tab, view, reset effect. |
| `src/locales/en.json` (modify) | New keys. |
| `docs/ipad-harness.md` (modify) | Destination section. |

---

### Task 1: `ipad` as a server-side surface (types, labels, prompt, tool-surface)

**Files:**
- Modify: `server/surface.ts` (types at lines 11-17, `SURFACES` line 37, `surfaceOfComputerKind` line 48, `surfaceLabel` line 108)
- Modify: `server/store.ts:660`
- Modify: `server/bot-overview.ts:198-212`
- Modify: `server/system-prompt.ts:44` and `:51-63`
- Modify: `shared/tool-surface.ts` (`screenSurfaceForTool`, `toolSurfaceKind`)
- Test: `server/surface.test.ts`, `server/bot-overview.test.ts`, `server/system-prompt.test.ts`, `shared/tool-surface.test.ts` (create if absent)

**Interfaces:**
- Produces: `Surface` includes `"ipad"`; `ComputerWant` includes `"ipad"`; `surfaceOfComputerKind(kind: "box" | "vps" | "vm" | "local" | "ipad" | null)`; `surfaceLabel("ipad") === "the iPad"`; `ComputerPromptKind` includes `"ipad"`; `computerReach("ipad")` returns `"Computer preference: the iPad."`.

- [ ] **Step 1: Write the failing tests**

Append to `server/surface.test.ts`:
```ts
describe("ipad surface", () => {
  it("parses, resolves and labels the iPad like a local place", () => {
    expect(parseSurface("ipad")).toBe("ipad");
    const plan = resolveSurface({ destination: "ipad", browserOn: true });
    expect(plan).toMatchObject({ computer: "ipad", browser: false, pinned: null });
    expect(resolveSurface({ destination: undefined, pinnedSurface: "ipad", browserOn: true })).toMatchObject({ computer: "ipad", pinned: "ipad" });
    expect(surfaceOfComputerKind("ipad")).toBe("ipad");
    expect(surfacePrompt({ computer: "ipad", browser: false })).toContain("the iPad");
  });
  it("attributes ipad tools to the mounted computer", () => {
    expect(surfaceForTool("mcp__ipad__tap", { computer: "ipad", browser: false })).toBe("ipad");
    expect(surfaceForTool("mcp__ipad__tap", { computer: "ipad", browser: true })).toBe("ipad");
  });
});
```
Append to `server/bot-overview.test.ts` inside its main describe, right after the "picks a computer automatically" case (line ~240); `baseFacts` and `buildBotOverview` are already in scope there:
```ts
  it("names the iPad preference", () => {
    const facts = baseFacts({ bot: { ...baseFacts().bot, computer: "ipad" } });
    const overview = buildBotOverview(facts);
    expect(overview.reaches).toContain("Computer preference: the iPad.");
    expect(overview.wont).not.toContain("Can't use a computer.");
  });
```

Append to `server/system-prompt.test.ts` inside `describe("computerPrompt")`:
```ts
  it("tells an iPad bot to read the screen and never enter secrets", () => {
    const prompt = computerPrompt("ipad");
    expect(prompt).toContain("through the ipad tools");
    expect(prompt).toContain("Never enter passwords");
    expect(prompt).toContain(SIGN_IN_PROMPT);
  });
```
(Add `SIGN_IN_PROMPT` to that file's import from `./system-prompt.ts`.)

Create or append `shared/tool-surface.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { screenSurfaceForTool, screenTouchingTool, toolSurfaceKind } from "./tool-surface";

describe("ipad tools", () => {
  it("count as computer tools that touch the screen", () => {
    expect(toolSurfaceKind("mcp__ipad__tap")).toBe("computer");
    expect(screenSurfaceForTool("mcp__ipad__type_text")).toBe("computer");
    expect(screenTouchingTool("mcp__ipad__tap_text")).toBe(true);
    expect(screenTouchingTool("mcp__ipad__swipe")).toBe(true);
    expect(screenTouchingTool("mcp__ipad__read_screen")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/surface.test.ts server/bot-overview.test.ts server/system-prompt.test.ts shared/tool-surface.test.ts`
Expected: FAIL (type errors on `"ipad"`, missing label, missing prompt kind, `toolSurfaceKind` returns null).

- [ ] **Step 3: Make the edits**

`server/surface.ts`:
```ts
export type Surface = "cloud" | "vm" | "local" | "browser" | "ipad";
export type ComputerWant = "cloud" | "vm" | "local" | "ipad" | "off" | undefined;
const SURFACES: ReadonlySet<string> = new Set(["cloud", "vm", "local", "browser", "ipad"]);
export function surfaceOfComputerKind(kind: "box" | "vps" | "vm" | "local" | "ipad" | null): Surface | null {
  if (kind === "box" || kind === "vps") return "cloud";
  return kind;
}
```
In `surfaceLabel`, add `case "ipad": return "the iPad";`. In `surfaceForTool`, before the `mcp__computer__` line add:
```ts
  if (toolName.startsWith("mcp__ipad__")) return mounted.computer === "ipad" ? "ipad" : null;
```

`server/store.ts:660`: `computer?: "cloud" | "vm" | "local" | "browser" | "ipad" | "off";`

`server/bot-overview.ts`, in `computerReach`: `case "ipad": return "Computer preference: the iPad.";`

`server/system-prompt.ts`:
```ts
export type ComputerPromptKind = "vm-private" | "vm-shared" | "box" | "box-agent" | "vps" | "local" | "ipad";
```
and in `COMPUTER_PARAGRAPH` add:
```ts
  ipad:
    " You can act on the user's iPad through the ipad tools. Call status first, read_screen before choosing a target and after every action, prefer tap_text, and use screenshot plus point tap only when accessibility text cannot identify the target. Type only into a field you have tapped. Never enter passwords, payment details, or one-time codes; ask the user to do those on the iPad.",
```

`shared/tool-surface.ts`: in `screenSurfaceForTool` and `toolSurfaceKind`, add `|| name.startsWith("mcp__ipad__")` to the computer condition. In `SCREEN_TOUCHING_TOOLS` add `"tap", "tap_text", "swipe", "open_app", "press"` under a comment `// iPad (WebDriverAgent)`.

- [ ] **Step 4: Run the tests and type-check**

Run: `pnpm exec vitest run server/surface.test.ts server/bot-overview.test.ts server/system-prompt.test.ts shared/tool-surface.test.ts src/lib/place.test.ts && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS. `tsc` will now report every exhaustive `switch`/`Record<Surface, …>` that lacks `ipad` (for example `surfaceLabel` if a case is missing, `selectableComputers` in index.ts is a `const` tuple and unaffected). Fix each by adding the `ipad` case with the values above; do not widen types to `string`.

- [ ] **Step 5: Commit**

```bash
git add server/surface.ts server/surface.test.ts server/store.ts server/bot-overview.ts server/bot-overview.test.ts server/system-prompt.ts server/system-prompt.test.ts shared/tool-surface.ts shared/tool-surface.test.ts
git commit -m "feat(ipad): ipad is a surface — types, labels, prompt paragraph, tool attribution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `server/ipad-device.ts` — status, cached frame, launcher child, routes

**Files:**
- Create: `server/ipad-device.ts`
- Test: `server/ipad-device.test.ts`

**Interfaces:**
- Consumes: `createWdaClient`, `wdaBaseUrl`, `START_HINT`, `WdaUnreachable`, `type FetchLike` from `./drivers/ipad-proxy.ts`; `SERVER_ROOT` from `./proxy-paths.ts`.
- Produces:
  ```ts
  export interface IpadStatus { reachable: boolean; device: string | null; os: string | null; startable: boolean; running: boolean; instruction: string; log: string[] }
  export interface IpadDevice {
    status(): Promise<IpadStatus>;
    frame(): Promise<Buffer>;                 // raw PNG; throws WdaUnreachable
    start(): { ok: true } | { ok: false; status: 409 | 501; error: string };
    stop(): void;
    previewCapture(): Promise<{ png: string; format: string }>;  // base64 for the turn preview pipeline
    handleRoute(method: string, path: string, res: ServerResponse): Promise<boolean>; // true when handled
  }
  export function createIpadDevice(options?: { fetch?: FetchLike; spawn?: typeof spawn; launcherPath?: string; env?: NodeJS.ProcessEnv; now?: () => number }): IpadDevice;
  export const LAUNCHER_PATH: string;  // join(SERVER_ROOT, "..", "scripts", "ipad-wda.mjs")
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// server/ipad-device.test.ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createIpadDevice } from "./ipad-device.ts";
import { START_HINT, type FetchLike } from "./drivers/ipad-proxy.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function wdaFetch(opts: { up: boolean; shots?: number[] }): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const path = new URL(input).pathname;
    calls.push(path);
    if (!opts.up) throw new Error("ECONNREFUSED");
    if (path === "/status") return { status: 200, json: async () => ({ value: { ready: true, device: "ipad", os: { name: "iPadOS", version: "26.6.1" } } }) };
    if (path === "/screenshot") return { status: 200, json: async () => ({ value: PNG.toString("base64") }) };
    return { status: 404, json: async () => ({ value: { error: "unknown command", message: path } }) };
  };
  return { fetch, calls };
}

class FakeChild extends EventEmitter {
  killed: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal: string) { this.killed = signal; this.emit("close", 0); return true; }
}
function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => { const child = new FakeChild(); children.push(child); return child as any; });
  return { spawn, children };
}

function fakeRes() {
  const res: any = { headers: {} as Record<string, string>, statusCode: 0, body: null as Buffer | string | null };
  res.writeHead = (status: number, headers: Record<string, string>) => { res.statusCode = status; res.headers = headers; return res; };
  res.end = (body?: Buffer | string) => { res.body = body ?? null; };
  return res;
}

describe("createIpadDevice", () => {
  it("reports reachable status with device and os", async () => {
    const wda = wdaFetch({ up: true });
    const device = createIpadDevice({ fetch: wda.fetch, launcherPath: "/nowhere/ipad-wda.mjs" });
    expect(await device.status()).toMatchObject({ reachable: true, device: "ipad", os: "iPadOS 26.6.1", startable: false, running: false });
  });

  it("reports unreachable with the start hint, and startable when the launcher exists", async () => {
    const wda = wdaFetch({ up: false });
    const device = createIpadDevice({ fetch: wda.fetch, launcherPath: import.meta.filename });
    const status = await device.status();
    expect(status).toMatchObject({ reachable: false, startable: true, running: false });
    expect(status.instruction).toBe(START_HINT);
  });

  it("caches a frame for one second and never touches a session route", async () => {
    let now = 1_000;
    const wda = wdaFetch({ up: true });
    const device = createIpadDevice({ fetch: wda.fetch, launcherPath: "/nowhere", now: () => now });
    expect((await device.frame()).equals(PNG)).toBe(true);
    await device.frame();
    expect(wda.calls.filter((p) => p === "/screenshot")).toHaveLength(1);
    now += 1_001;
    await device.frame();
    expect(wda.calls.filter((p) => p === "/screenshot")).toHaveLength(2);
    expect(wda.calls.some((p) => p.startsWith("/session"))).toBe(false);
  });

  it("previewCapture returns base64 png for the turn preview pipeline", async () => {
    const wda = wdaFetch({ up: true });
    const device = createIpadDevice({ fetch: wda.fetch, launcherPath: "/nowhere" });
    expect(await device.previewCapture()).toEqual({ png: PNG.toString("base64"), format: "png" });
  });

  it("starts the launcher once, tracks running, collects log lines, and stops with SIGINT", async () => {
    const wda = wdaFetch({ up: false });
    const { spawn, children } = fakeSpawn();
    const device = createIpadDevice({ fetch: wda.fetch, spawn, launcherPath: import.meta.filename });
    expect(device.start()).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(process.execPath, [import.meta.filename], expect.objectContaining({ cwd: expect.any(String) }));
    expect(device.start()).toEqual({ ok: false, status: 409, error: "WebDriverAgent launcher is already running" });
    children[0].stdout.emit("data", Buffer.from("iPad: iPad (3)\nBuilding...\n"));
    expect((await device.status())).toMatchObject({ running: true, log: ["iPad: iPad (3)", "Building..."] });
    device.stop();
    expect(children[0].killed).toBe("SIGINT");
    expect((await device.status()).running).toBe(false);
  });

  it("refuses to start when the launcher is missing", () => {
    const device = createIpadDevice({ fetch: wdaFetch({ up: false }).fetch, spawn: fakeSpawn().spawn, launcherPath: "/nowhere/ipad-wda.mjs" });
    expect(device.start()).toEqual({ ok: false, status: 501, error: "WebDriverAgent can only be started from a source checkout: run pnpm ipad:wda there" });
  });

  it("serves the four routes", async () => {
    const wda = wdaFetch({ up: true });
    const { spawn } = fakeSpawn();
    const device = createIpadDevice({ fetch: wda.fetch, spawn, launcherPath: import.meta.filename });
    let res = fakeRes();
    expect(await device.handleRoute("GET", "/api/ipad/status", res)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(res.body))).toMatchObject({ reachable: true });
    res = fakeRes();
    await device.handleRoute("GET", "/api/ipad/frame", res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    res = fakeRes();
    await device.handleRoute("POST", "/api/ipad/start", res);
    expect(res.statusCode).toBe(200);
    res = fakeRes();
    await device.handleRoute("POST", "/api/ipad/start", res);
    expect(res.statusCode).toBe(409);
    res = fakeRes();
    await device.handleRoute("POST", "/api/ipad/stop", res);
    expect(res.statusCode).toBe(200);
    expect(await device.handleRoute("GET", "/api/other", fakeRes())).toBe(false);
  });

  it("answers 503 for a frame when WDA is down", async () => {
    const device = createIpadDevice({ fetch: wdaFetch({ up: false }).fetch, launcherPath: "/nowhere" });
    const res = fakeRes();
    await device.handleRoute("GET", "/api/ipad/frame", res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(String(res.body)).error).toContain("pnpm ipad:wda");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/ipad-device.test.ts`
Expected: FAIL — cannot resolve `./ipad-device.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// server/ipad-device.ts
// The harness's own view of the iPad: reachability, a mirror frame, and the
// developer launcher. Session-less WDA routes only, so a mirror never
// disturbs the session a turn's proxy holds (a second WDA session deletes
// the first mid-request).
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { START_HINT, WdaUnreachable, createWdaClient, wdaBaseUrl, type FetchLike } from "./drivers/ipad-proxy.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";

export const LAUNCHER_PATH = join(SERVER_ROOT, "..", "scripts", "ipad-wda.mjs");
const FRAME_CACHE_MS = 1_000;
const LOG_LINES = 20;
const NOT_STARTABLE = "WebDriverAgent can only be started from a source checkout: run pnpm ipad:wda there";

export interface IpadStatus {
  reachable: boolean;
  device: string | null;
  os: string | null;
  startable: boolean;
  running: boolean;
  instruction: string;
  log: string[];
}

export interface IpadDevice {
  status(): Promise<IpadStatus>;
  frame(): Promise<Buffer>;
  start(): { ok: true } | { ok: false; status: 409 | 501; error: string };
  stop(): void;
  previewCapture(): Promise<{ png: string; format: string }>;
  handleRoute(method: string, path: string, res: ServerResponse): Promise<boolean>;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export function createIpadDevice(options: {
  fetch?: FetchLike;
  spawn?: typeof nodeSpawn;
  launcherPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
} = {}): IpadDevice {
  const launcherPath = options.launcherPath ?? LAUNCHER_PATH;
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  const client = createWdaClient({ fetch: options.fetch ?? (fetch as unknown as FetchLike), baseUrl: wdaBaseUrl(options.env ?? process.env) });

  let child: ChildProcess | null = null;
  let log: string[] = [];
  let cached: { at: number; png: Buffer } | null = null;
  let inFlight: Promise<Buffer> | null = null;

  const startable = () => existsSync(launcherPath);
  const pushLog = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      log.push(line.trimEnd());
      if (log.length > LOG_LINES) log = log.slice(-LOG_LINES);
    }
  };

  async function status(): Promise<IpadStatus> {
    let reachable = false;
    let device: string | null = null;
    let os: string | null = null;
    try {
      const value = (await client.get("/status")) as Record<string, unknown> | null;
      reachable = true;
      device = str(value?.device) || "ipad";
      const osInfo = (value?.os ?? {}) as Record<string, unknown>;
      os = `${str(osInfo.name) || "iPadOS"} ${str(osInfo.version)}`.trim();
    } catch (error) {
      if (!(error instanceof WdaUnreachable)) throw error;
    }
    return { reachable, device, os, startable: startable(), running: child !== null, instruction: START_HINT, log: [...log] };
  }

  function frame(): Promise<Buffer> {
    if (cached && now() - cached.at < FRAME_CACHE_MS) return Promise.resolve(cached.png);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const png = Buffer.from(str(await client.get("/screenshot", 30_000)), "base64");
        if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("WebDriverAgent returned an invalid screenshot");
        cached = { at: now(), png };
        return png;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function start(): ReturnType<IpadDevice["start"]> {
    if (child) return { ok: false, status: 409, error: "WebDriverAgent launcher is already running" };
    if (!startable()) return { ok: false, status: 501, error: NOT_STARTABLE };
    log = [];
    const proc = spawn(process.execPath, [launcherPath], {
      cwd: dirname(dirname(launcherPath)),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("error", (error) => { pushLog(Buffer.from(`launcher error: ${error.message}\n`)); child = null; });
    proc.on("close", (code) => { pushLog(Buffer.from(`launcher exited with ${code ?? "signal"}\n`)); child = null; });
    return { ok: true };
  }

  function stop(): void {
    child?.kill("SIGINT");
  }

  const json = (res: ServerResponse, statusCode: number, body: unknown) => {
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function handleRoute(method: string, path: string, res: ServerResponse): Promise<boolean> {
    if (method === "GET" && path === "/api/ipad/status") {
      json(res, 200, await status());
      return true;
    }
    if (method === "GET" && path === "/api/ipad/frame") {
      try {
        const png = await frame();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(png);
      } catch (error) {
        json(res, error instanceof WdaUnreachable ? 503 : 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (method === "POST" && path === "/api/ipad/start") {
      const result = start();
      if (result.ok) json(res, 200, { ok: true });
      else json(res, result.status, { error: result.error });
      return true;
    }
    if (method === "POST" && path === "/api/ipad/stop") {
      stop();
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return {
    status,
    frame,
    start,
    stop,
    previewCapture: async () => ({ png: (await frame()).toString("base64"), format: "png" }),
    handleRoute,
  };
}
```

Note `import.meta.filename` in the test requires Node 20.11+; the repo runs Node 22/24.

- [ ] **Step 4: Run the tests and type-check**

Run: `pnpm exec vitest run server/ipad-device.test.ts && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ipad-device.ts server/ipad-device.test.ts
git commit -m "feat(ipad): harness iPad device service — status, cached frame, launcher child, routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire the service and the dispatch branch into `server/index.ts`

**Files:**
- Modify: `server/index.ts` — import near line 370; module-level device beside `ipadProxyPath` (line ~850); route delegation next to the `GET /api/config` handler (line ~15975); PATCH validation (line ~13744); dispatch `computerKind` union (line ~5710), branch after the `wants === "local"` block (line ~5796), trigger mount (line ~5622), prompt-kind mapping (line ~6070); channel refusal (line ~7599).

**Interfaces:**
- Consumes: `createIpadDevice`, `IpadDevice` from Task 2; `ipadIntegration()` (exists from the harness work); `claimTurnResource`, `surfaceOfComputerKind`, `computerPrompt`.
- Produces: `ipadDevice: IpadDevice` module singleton; `/api/ipad/*` served; a bot with `computer: "ipad"` mounts the tools every turn.

- [ ] **Step 1: Make the edits**

Import (near the other `./` imports, e.g. after `proxy-paths`):
```ts
import { createIpadDevice } from "./ipad-device.ts";
```
Module level, after `const ipadProxyPath = SPAWNED_PROXIES.ipad;`:
```ts
const ipadDevice = createIpadDevice();
```

Route delegation. Find the `if (method === "GET" && path === "/api/config") {` handler (line ~15975) and add immediately before it:
```ts
    if (path.startsWith("/api/ipad/")) {
      if (await ipadDevice.handleRoute(method, path, res)) return;
    }
```

PATCH validation (line ~13744): change the list to `["cloud", "vm", "local", "browser", "ipad", "off"]`.

Dispatch. Change the `computerKind` declaration:
```ts
      let computerKind: "box" | "vps" | "vm" | "local" | "ipad" | null = null;
```
After the `wants === "local"` block's closing brace (the one ending with `computerKind = "local";` then `}`), add:
```ts
      else if (wants === "ipad") {
        if (!claimTurnResource(resourceOwner, "computer:ipad")) throw new Error("another thread is using the iPad — wait for it to finish");
        integrations.ipad = ipadIntegration();
        computerKind = "ipad";
        previewCapture = () => ipadDevice.previewCapture();
      }
```
(Attach it to the same `if/else if` chain: the line before must be `}` of the local branch; make it `} else if (wants === "ipad") {`.)

Trigger mount (the block added by the harness work, line ~5622, inside the same function):
```ts
      if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("ipadMcp")) && !integrations.ipad) {
        if (!claimTurnResource(resourceOwner, "computer:ipad")) throw new Error("another thread is using the iPad — wait for it to finish");
        integrations.ipad = ipadIntegration();
        if (computerKind === null) {
          computerKind = "ipad";
          previewCapture = () => ipadDevice.previewCapture();
        }
      }
```
Check ordering: `computerKind` and `previewCapture` are declared at line ~5709, after the skill selection block at ~5605. If the trigger block runs before those `let`s, move the trigger block down to just after the new `wants === "ipad"` branch so both variables exist; keep the `claimTurnResource` guard.

Prompt-kind mapping (line ~6070): extend the ternary:
```ts
              : computerKind === "local"
                ? "local"
                : computerKind === "ipad"
                  ? "ipad"
                  : null;
```

Channel refusal (line ~7599): `(roomPlan.computer === "cloud" || roomPlan.computer === "local" || roomPlan.computer === "ipad")` and append " or iPad" nowhere — keep the message as is; it already says to open a bot thread.

The second skill-selection site (line ~7425, rooms) mounts by trigger only; leave it.

- [ ] **Step 2: Type-check and run the server tests that touch dispatch**

Run: `pnpm exec tsc -p tsconfig.server.json --noEmit && pnpm exec vitest run server/surface.test.ts server/skill-library.test.ts server/proxy-paths.test.ts`
Expected: clean and PASS. If `tsc` flags `surfaceOfComputerKind(computerKind)` or `Record<…>` sites, the union from Task 1 already includes `ipad`; fix any remaining exhaustive switch by adding the `ipad` case.

- [ ] **Step 3: Smoke the routes against a running harness**

Start an isolated harness (spare port, isolated data dir, real HOME):
```bash
ISO=/private/tmp/omb-ipad-dest && mkdir -p $ISO/.openmausbot && OMB_PORT=18999 OMB_DATA_DIR=$ISO/.openmausbot OMB_USER_DATA="$HOME/Library/Application Support/openmausbot" OMB_SKILLS_DIR="$PWD/skills" node --experimental-strip-types server/index.ts > $ISO/harness.log 2>&1 &
sleep 3; curl -s http://127.0.0.1:18999/api/ipad/status; echo; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18999/api/ipad/frame
```
Expected: JSON with `startable: true`; frame is `200` when `pnpm ipad:wda` is running, else `503`. Then `curl -s -X POST http://127.0.0.1:18999/api/ipad/start` → `{"ok":true}` and a later status shows `running: true` with log lines. Stop the harness afterwards (`kill %1`).

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat(ipad): iPad destination in the dispatch — every-turn mount, preview capture, /api/ipad routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Renderer place model — `ipad` in place, chip, icon, panel-view storage, store types, locale

**Files:**
- Modify: `src/lib/place.ts` (Place, PLACES, isComputerPlace), `src/lib/computer-panel-view.ts`, `src/state/store.tsx:275,349`, `src/components/PlaceIcon.tsx`, `src/components/PlaceChip.tsx` (availability + DESCRIPTION), `src/components/LocalComputerSection.tsx:125-129`, `src/locales/en.json`
- Create: `src/lib/ipad-place.ts`
- Test: `src/lib/place.test.ts`, `src/lib/ipad-place.test.ts`

**Interfaces:**
- Produces: `Place` includes `"ipad"`; `ComputerPanelView` includes `"ipad"`; locale keys `place.ipad`, `vm.dest.ipad`, `computer.dest.ipadDesc`, `computer.tab.ipad`, `computer.ipad.connected`, `computer.ipad.unreachable`, `computer.ipad.start`, `computer.ipad.stop`, `computer.ipad.starting`, `computer.ipad.screenAlt`, `computer.ipad.notStartable`;
  ```ts
  // src/lib/ipad-place.ts
  export interface IpadStatusView { reachable: boolean; startable: boolean; running: boolean; instruction: string; device?: string | null; os?: string | null; log?: string[] }
  export function ipadTileState(status: IpadStatusView | null): { enabled: boolean; reason: string | null };
  export function ipadTabVisible(status: IpadStatusView | null, computer: string | undefined): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/place.test.ts`:
```ts
  it("treats the iPad as a computer place with its own label key", () => {
    expect(effectivePlace({ computer: "ipad" }, null)).toBe("ipad");
    expect(effectivePlace({ computer: undefined }, { surface: "ipad" })).toBe("ipad");
    expect(isComputerPlace("ipad")).toBe(true);
    expect(placeLabelKey("ipad")).toBe("place.ipad");
    expect(toolPlace("mcp__ipad__tap", "ipad")).toBe("ipad");
  });
```
Create `src/lib/ipad-place.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ipadTabVisible, ipadTileState } from "./ipad-place";

const base = { reachable: false, startable: false, running: false, instruction: "run pnpm ipad:wda" };

describe("ipadTileState", () => {
  it("is enabled when reachable or startable, disabled with the instruction otherwise", () => {
    expect(ipadTileState({ ...base, reachable: true })).toEqual({ enabled: true, reason: null });
    expect(ipadTileState({ ...base, startable: true })).toEqual({ enabled: true, reason: null });
    expect(ipadTileState(base)).toEqual({ enabled: false, reason: "run pnpm ipad:wda" });
    expect(ipadTileState(null)).toEqual({ enabled: false, reason: null });
  });
});

describe("ipadTabVisible", () => {
  it("shows the tab for an iPad bot, or whenever the device is reachable", () => {
    expect(ipadTabVisible(base, "ipad")).toBe(true);
    expect(ipadTabVisible({ ...base, reachable: true }, undefined)).toBe(true);
    expect(ipadTabVisible(base, "vm")).toBe(false);
    expect(ipadTabVisible(null, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/place.test.ts src/lib/ipad-place.test.ts`
Expected: FAIL.

- [ ] **Step 3: Make the edits**

`src/lib/place.ts`:
```ts
export type Place = "cloud" | "vm" | "local" | "browser" | "ipad";
export const PLACES: readonly Place[] = ["cloud", "vm", "local", "browser", "ipad"];
export function isComputerPlace(place: EffectivePlace): place is "cloud" | "vm" | "local" | "ipad" {
  return place === "cloud" || place === "vm" || place === "local" || place === "ipad";
}
```

`src/lib/ipad-place.ts`:
```ts
// Pure decisions for the iPad tile and tab, kept out of the panel so they
// can be tested without rendering.
export interface IpadStatusView {
  reachable: boolean;
  startable: boolean;
  running: boolean;
  instruction: string;
  device?: string | null;
  os?: string | null;
  log?: string[];
}

export function ipadTileState(status: IpadStatusView | null): { enabled: boolean; reason: string | null } {
  if (!status) return { enabled: false, reason: null };
  if (status.reachable || status.startable) return { enabled: true, reason: null };
  return { enabled: false, reason: status.instruction };
}

export function ipadTabVisible(status: IpadStatusView | null, computer: string | undefined): boolean {
  if (computer === "ipad") return true;
  return status?.reachable === true;
}
```

`src/lib/computer-panel-view.ts`: add `"ipad"` to the union and to the `if (value === "android" || …)` check.

`src/state/store.tsx`: line 275 `surface?: "cloud" | "vm" | "local" | "browser" | "ipad";` and line 349 `computer?: "cloud" | "vm" | "local" | "browser" | "ipad" | "off";`.

`src/components/PlaceIcon.tsx`: import `Tablet` from lucide-react and add `ipad: Tablet` to `ICONS`.

`src/components/PlaceChip.tsx`: in `usePlaceAvailability` add `ipad: true,` (the panel greys the tile from live status; the chip may always offer a pin, which the server honours or reports). In `DESCRIPTION` add `ipad: "computer.dest.ipadDesc"` and widen its value type to include that key.

`src/components/LocalComputerSection.tsx:125-129`: add `ipad: "vm.dest.ipad",`.

`src/locales/en.json`, next to the existing keys of each family:
```json
  "vm.dest.ipad": "iPad",
  "computer.dest.ipadDesc": "Your iPad over USB",
  "computer.tab.ipad": "iPad",
  "place.ipad": "iPad",
  "computer.ipad.connected": "Connected: {device}, {os}",
  "computer.ipad.unreachable": "WebDriverAgent is not running on the iPad.",
  "computer.ipad.notStartable": "Run pnpm ipad:wda from a source checkout, then this panel connects on its own.",
  "computer.ipad.start": "Start WebDriverAgent",
  "computer.ipad.starting": "Starting on the iPad… the first build takes a few minutes.",
  "computer.ipad.stop": "Stop",
  "computer.ipad.screenAlt": "iPad screen",
  "computer.ipad.hint": "The bot drives; this view only watches. Keep the iPad unlocked and on USB."
```

- [ ] **Step 4: Run the tests and the renderer type-check**

Run: `pnpm exec vitest run src/lib/place.test.ts src/lib/ipad-place.test.ts src/components/ComputerPanel.i18n.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: PASS and clean. `tsc` will point at every `Record<Place, …>` and exhaustive switch in the renderer lacking `ipad` (PlaceChip's `DESCRIPTION`, `usePlaceAvailability`, any `PLACES.map` label table); fix each with the `ipad` value named above.

- [ ] **Step 5: Commit**

```bash
git add src/lib/place.ts src/lib/place.test.ts src/lib/ipad-place.ts src/lib/ipad-place.test.ts src/lib/computer-panel-view.ts src/state/store.tsx src/components/PlaceIcon.tsx src/components/PlaceChip.tsx src/components/LocalComputerSection.tsx src/locales/en.json
git commit -m "feat(ipad): iPad as a renderer place — chip, icon, labels, panel-view storage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `IpadDevicePanel` and the Computer panel tile, tab and view

**Files:**
- Create: `src/components/IpadDevicePanel.tsx`
- Modify: `src/components/ComputerPanel.tsx` — imports (line ~44), status hook beside `useAndroidUsbDevices()` (line ~319), reset effect (line ~404), tab strip (line ~1207), view switch (line ~1259), tile list (line ~1623), disabled/title logic (line ~1631-1645)

**Interfaces:**
- Consumes: `api(path, init)` from `@/state/store` (`export async function api(path: string, init?: RequestInit): Promise<any>`), `usePageVisible` from `@/lib/page-visible`, `ipadTileState`, `ipadTabVisible`, `type IpadStatusView` from Task 4, `Tablet` icon.
- Produces: `useIpadDevice(): IpadStatusView | null` (polls `GET /api/ipad/status` every 2 s while visible); `IpadDevicePanel({ status })`.

- [ ] **Step 1: Write the component**

```tsx
// src/components/IpadDevicePanel.tsx
import { useEffect, useState } from "react";
import { Loader2, Tablet } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { IpadStatusView } from "@/lib/ipad-place";

const STATUS_POLL_MS = 2_000;
const FRAME_POLL_MS = 2_000;

/** Polls the harness's iPad status while the page is visible. Null until
 * the first answer, and null again when the harness cannot be reached. */
export function useIpadDevice(): IpadStatusView | null {
  const [status, setStatus] = useState<IpadStatusView | null>(null);
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    let alive = true;
    const refresh = async () => {
      try {
        const next = (await api("/api/ipad/status")) as IpadStatusView;
        if (alive) setStatus(next);
      } catch {
        if (alive) setStatus(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pageVisible]);
  return status;
}

export function IpadDevicePanel({ status }: { status: IpadStatusView | null }) {
  const pageVisible = usePageVisible();
  const [frame, setFrame] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reachable = status?.reachable === true;

  useEffect(() => {
    // one WebDriverAgent screenshot per tick — nothing to show while hidden
    if (!reachable || !pageVisible) return;
    let alive = true;
    let timer: number | null = null;
    let url: string | null = null;
    const capture = async () => {
      try {
        const response = await fetch(`/api/ipad/frame?t=${Date.now()}`, { credentials: "include" });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? `HTTP ${response.status}`);
        const blob = await response.blob();
        if (!alive) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        setFrame(url);
        setStale(false);
        setError(null);
      } catch (cause) {
        if (alive) {
          setStale(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (alive) timer = window.setTimeout(() => void capture(), FRAME_POLL_MS);
      }
    };
    void capture();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [reachable, pageVisible]);

  const control = async (action: "start" | "stop") => {
    setPending(true);
    setError(null);
    try {
      await api(`/api/ipad/${action}`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
        <Tablet size={14} />
        {reachable
          ? t("computer.ipad.connected", { device: status?.device ?? "iPad", os: status?.os ?? "" })
          : t("computer.ipad.unreachable")}
        {status?.running && <Loader2 size={13} className="animate-spin" />}
        <span className="ml-auto flex gap-2">
          {!reachable && status?.startable && !status.running && (
            <button type="button" disabled={pending} onClick={() => void control("start")} className="rounded-md bg-control px-2 py-1 text-ink hover:bg-control/80">
              {t("computer.ipad.start")}
            </button>
          )}
          {status?.running && (
            <button type="button" disabled={pending} onClick={() => void control("stop")} className="rounded-md bg-control px-2 py-1 text-ink hover:bg-control/80">
              {t("computer.ipad.stop")}
            </button>
          )}
        </span>
      </div>
      {!reachable && status?.running && <p className="text-[12px] text-ink-secondary">{t("computer.ipad.starting")}</p>}
      {!reachable && status && !status.startable && !status.running && (
        <p className="text-[12px] text-ink-secondary">{t("computer.ipad.notStartable")}</p>
      )}
      {frame ? (
        <img src={frame} alt={t("computer.ipad.screenAlt")} className={stale ? "max-h-full w-full rounded-lg object-contain opacity-50" : "max-h-full w-full rounded-lg object-contain"} />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-lg bg-card text-[12px] text-ink-secondary">{t("computer.ipad.hint")}</div>
      )}
      {status?.log && status.log.length > 0 && !reachable && (
        <pre className="max-h-32 overflow-auto rounded-lg bg-card p-2 text-[11px] leading-4 text-ink-secondary">{status.log.join("\n")}</pre>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      )}
    </div>
  );
}
```

Check `api()` in `src/state/store.tsx:2044`: if it throws an `ApiError` carrying the server's `error` text, the catch above already shows it. If `api` only accepts JSON responses, the frame fetch deliberately bypasses it (it wants a blob).

- [ ] **Step 2: Wire the Computer panel**

Imports (near line 44):
```tsx
import { Tablet } from "lucide-react"; // add to the existing lucide import list
import { IpadDevicePanel, useIpadDevice } from "./IpadDevicePanel";
import { ipadTabVisible, ipadTileState } from "@/lib/ipad-place";
```
Status hook, right after `const androidConnected = androidStatus.devices.length > 0;`:
```tsx
  const ipadStatus = useIpadDevice();
  const ipadTile = ipadTileState(ipadStatus);
  const ipadTab = ipadTabVisible(ipadStatus, profileBot.computer);
```
Reset effect (line ~404): extend the condition:
```tsx
    if ((!androidConnected && panelView === "android") || (!browserEnabled && panelView === "browser") || (!ipadTab && panelView === "ipad")) {
```
and add `ipadTab` to that effect's dependency array.

Tab strip: after the Android tab block, add:
```tsx
            {ipadTab && (
            <button
              type="button"
              onClick={() => selectPanelView("ipad")}
              aria-pressed={panelView === "ipad"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "ipad" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Tablet size={13} /> {t("computer.tab.ipad")}
              {placeLive && livePlace === "ipad" && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="ipad-tab-live" />}
            </button>
            )}
```
View switch: before the Android view branch add:
```tsx
      ) : panelView === "ipad" && ipadTab ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-2">
          <IpadDevicePanel status={ipadStatus} />
        </div>
```
Tile list: insert after the `browser` row:
```tsx
              ["ipad", "vm.dest.ipad", "computer.dest.ipadDesc", Tablet],
```
Disabled/title logic: add `(mode === "ipad" && !ipadTile.enabled) ||` to `disabled`, and to `unavailableTitle` a branch `mode === "ipad" ? ipadTile.reason ?? undefined :` before the browser branch. The `onClick` needs no change: `updateComputerSelection({ computer: mode })` already handles a new value.

Also open the tab when the bot is set to iPad: in the "Restore a manually chosen tab" effect (line ~377), mirror the browser rule:
```tsx
    setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
      : bot.computer === "ipad" ? "ipad"
      : previous === null ? readComputerPanelView(bot.id) : "computer");
```

- [ ] **Step 3: Type-check and run the panel tests**

Run: `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run src/components/ComputerPanel.test.ts src/components/ComputerPanel.i18n.test.ts src/lib/ipad-place.test.ts`
Expected: clean and PASS. The i18n test may assert every `t("…")` key in the panel exists in `en.json`; the Task 4 keys cover the ones used here.

- [ ] **Step 4: Look at it**

With the isolated harness from Task 3 running on 18999, run the renderer against it: `OMB_PORT=18999 node_modules/.bin/vite --port 5399 --strictPort`, open `http://127.0.0.1:5399/` in a browser (Playwright MCP or a plain tab), open a bot's Computer panel. Expected: an iPad tile (enabled while `pnpm ipad:wda` is running or startable), choosing it switches the panel to the iPad tab, the mirror updates every two seconds, and the composer chip reads "iPad". Take a screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add src/components/IpadDevicePanel.tsx src/components/ComputerPanel.tsx
git commit -m "feat(ipad): iPad tile, tab and live mirror in the Computer panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Phone apps, docs, end-to-end check

**Files:**
- Verify: `ios/Sources/CompanionCore/Models.swift:365` (`computer: String?`), `ios/App/ComputerView.swift:68`, Android bot model under `android/app/src/main/kotlin/com/openmausbot/companion/`
- Modify: `docs/ipad-harness.md`

- [ ] **Step 1: Confirm the phone apps tolerate the new value**

Run:
```bash
grep -rn -E 'computer == "|computer\?\.|switch .*computer' ios/App ios/Sources | grep -v cloudBackend
grep -rn -E '\.computer\b' android/app/src/main/kotlin | head
```
Expected: the iOS bot model decodes `computer` as an optional String and the only comparison is the cloud check in `ComputerView.swift`; Android has no comparisons. If either app has an exhaustive mapping of computer values to labels, add the `ipad` → "iPad" case there and note the file in the commit; otherwise no phone change is needed and the spec's phone section is satisfied by decoding.

- [ ] **Step 2: Update the docs**

In `docs/ipad-harness.md`, replace the "Running" paragraph that starts "Then, in OpenMausBot, ask a bot" with:
```markdown
Then, in OpenMausBot, either set the bot's **Works on** to **iPad** in the
Computer panel (the iPad tile is enabled while WebDriverAgent answers or can
be started from this checkout) or leave it on Auto and mention the iPad in
your message. An iPad bot has the tools on every turn and the panel's iPad
tab mirrors the screen. An Auto conversation that started with "on the iPad"
stays on the iPad for its follow-ups. Only one thread can drive the iPad at
a time.

The iPad tab also has a **Start WebDriverAgent** button when the app runs
from a source checkout; the packaged app shows the manual instruction.
```

- [ ] **Step 3: End-to-end on the device**

With `pnpm ipad:wda` running (or started from the panel), on the isolated harness: `PATCH /api/bots/<id>` with `{"computer":"ipad"}`, then send "Open Safari and search for OpenMausBot" (no iPad wording). Expected: the bot uses the `ipad` tools without the trigger word, the iPad tab's mirror follows along, and the reply says where it worked ("the iPad"). Then send a plain follow-up ("go back home") and confirm it still acts on the device.

- [ ] **Step 4: Full checks and commit**

Run: `pnpm exec vitest run && pnpm exec tsc -p tsconfig.server.json --noEmit && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: the only failures are the five pre-existing `BotProfileAvatarCard.test.ts` cases.

```bash
git add docs/ipad-harness.md
git commit -m "docs(ipad): iPad as a Works-on destination

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Stop here. Omkar owns pushing and PRs.
