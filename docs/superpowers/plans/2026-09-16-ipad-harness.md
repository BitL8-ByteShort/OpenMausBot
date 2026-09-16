# iPad Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OpenMausBot bots a first-party `ipad` MCP tool set that sees and operates a physical iPad through WebDriverAgent, mounted the same way the Android `phone` tools are.

**Architecture:** A new stdio MCP proxy, `server/drivers/ipad-proxy.ts`, speaks HTTP to WebDriverAgent (WDA) on loopback port 8100 and exposes nine tools. A bundled skill `skills/ipad-harness` selects it by trigger terms; the server mounts it per turn behind an `ipadMcp` driver capability exactly like `phoneMcp`. A developer-only launcher, `scripts/ipad-wda.mjs`, builds the Appium WebDriverAgent runner from the pinned npm package, runs it on the USB-attached iPad, and forwards port 8100 with `iproxy`.

**Tech Stack:** Node 24 (TypeScript with `--experimental-strip-types`), vitest, hand-rolled JSON-RPC over stdio (no MCP SDK, matching phone-proxy), WebDriverAgent HTTP API, `xcodebuild`, `xcrun devicectl`, `iproxy` (libimobiledevice), macOS `sips`.

**Spec:** `docs/superpowers/specs/2026-09-16-ipad-harness-design.md`

## Global Constraints

- The proxy imports nothing from the rest of `server/` (only `node:` builtins). `scripts/bundle-server.mjs` bundles `drivers/*` entries standalone and `proxy-paths.ts` relies on that.
- WDA is reachable on loopback only. `OMB_IPAD_WDA_URL` may change the port; any non-loopback host is refused.
- All coordinates exposed to the model are iPad points. Screenshots are downscaled so pixels equal points.
- Tool names and behaviour mirror `server/drivers/phone-proxy.ts`: `status`, `read_screen`, `screenshot`, `open_app`, `tap_text`, `tap`, `swipe`, `type_text`, `press`.
- Per-call timeouts: 15 s default, 30 s for `screenshot` and `read_screen`.
- `read_screen` returns at most 300 visible elements. `type_text` accepts 1–512 printable characters.
- The MCP server name is `ipad`; `mcp-registry.ts` must reserve it.
- Signing team for the WDA runner: `OMB_IOS_TEAM_ID`, defaulting to the `teamID` string in `ios/ExportOptions.plist` (currently `R2J9MJAU6H`).
- Pinned devDependency: `appium-webdriveragent@16.12.8`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run tests with `pnpm exec vitest run <file>`; type-check with `pnpm exec tsc -p tsconfig.server.json --noEmit`.
- Work happens in the worktree `/Users/omkar/Desktop/openmaus/OpenGrokBot-ipad` on branch `feat/ipad-harness`. Never push or open a PR; Omkar does that.

## File map

| File | Responsibility |
| --- | --- |
| `server/drivers/ipad-proxy.ts` (create) | The whole proxy: URL policy, source flattening, action builders, app lookup, WDA client with session retry, tool runner, TOOLS table, stdio loop. Pure helpers are exported for tests; the stdio loop only runs when the file is the entry script. |
| `server/drivers/ipad-proxy.test.ts` (create) | Unit tests with an injected `fetch` and injected downscaler. |
| `server/proxy-paths.ts` (modify) | `SPAWNED_PROXIES.ipad`. |
| `server/proxy-paths.test.ts` (modify) | Asserts the new entry exists. |
| `scripts/bundle-server.mjs` (modify) | Adds the entry point. |
| `server/mcp-registry.ts` + `.test.ts` (modify) | Reserves `ipad`. |
| `server/contracts.ts` (modify) | `integrations.ipad` spec and `ipadMcp` capability. |
| `server/drivers/claude.ts`, `codex.ts`, `pi.ts` (modify) | Declare `ipadMcp: true`; mount `turn.integrations.ipad`. |
| `server/harness/registry.ts` (modify) | Expose `ipadMcp`. |
| `server/index.ts` (modify) | `ipadIntegration()`; both skill-selection sites offer `ipadMcp` and mount behind `computer:ipad`. |
| `server/skill-library.test.ts` (modify) | Trigger-term selection test for the new skill. |
| `skills/ipad-harness/manifest.json`, `SKILL.md`, `agents/openai.yaml` (create) | The bundled skill. |
| `scripts/ipad-wda.mjs` + `scripts/ipad-wda.test.ts` (create) | Developer launcher and its pure command plan. |
| `package.json` (modify) | devDependency and `ipad:wda` script. |
| `docs/ipad-harness.md` (create) | Setup, demo flow, limitations. |

## WebDriverAgent HTTP surface used (reference for every task)

Every WDA response is JSON `{ "value": ..., "sessionId": ... }`. Errors carry HTTP 4xx/5xx with `{ "value": { "error": "invalid session id", "message": "..." } }`.

| Call | Purpose |
| --- | --- |
| `GET /status` | `value.ready`, `value.os.version`, `value.device` |
| `POST /session` body `{"capabilities":{"alwaysMatch":{},"firstMatch":[{}]}}` | `value.sessionId` |
| `GET /session/:id/window/size` | `value.width`, `value.height` in points |
| `GET /session/:id/wda/screen` | `value.scale` |
| `GET /source?format=json` | nested tree `{type,label,name,value,rect:{x,y,width,height},isVisible:"1",children:[]}` |
| `GET /screenshot` | `value` is base64 PNG |
| `POST /session/:id/wda/apps/launch` body `{"bundleId":"..."}` | launch app |
| `POST /session/:id/wda/keys` body `{"value":["text"]}` | type into focused field |
| `POST /session/:id/wda/homescreen` body `{}` | press home |
| `POST /session/:id/actions` body `{"actions":[...]}` | W3C touch actions |

---

### Task 1: Proxy core — URL policy and source flattening

**Files:**
- Create: `server/drivers/ipad-proxy.ts`
- Test: `server/drivers/ipad-proxy.test.ts`

**Interfaces:**
- Produces: `wdaBaseUrl(env?: NodeJS.ProcessEnv): string`, `type ScreenElement = { type: string; label: string; name: string; value: string; rect: { x: number; y: number; width: number; height: number } }`, `flattenSource(root: unknown, limit?: number): ScreenElement[]`, `elementLines(elements: ScreenElement[]): string`, `MAX_ELEMENTS = 300`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/drivers/ipad-proxy.test.ts
import { describe, expect, it } from "vitest";

import {
  MAX_ELEMENTS,
  elementLines,
  flattenSource,
  wdaBaseUrl,
} from "./ipad-proxy.ts";

const el = (type: string, extra: Record<string, unknown> = {}) => ({
  type: `XCUIElementType${type}`, label: "", name: "", value: "", isVisible: "1",
  rect: { x: 0, y: 0, width: 10, height: 10 }, children: [], ...extra,
});

describe("wdaBaseUrl", () => {
  it("defaults to loopback 8100", () => {
    expect(wdaBaseUrl({})).toBe("http://127.0.0.1:8100");
  });
  it("accepts a loopback override and strips a trailing slash", () => {
    expect(wdaBaseUrl({ OMB_IPAD_WDA_URL: "http://localhost:8200/" })).toBe("http://localhost:8200");
  });
  it("refuses a non-loopback host", () => {
    expect(() => wdaBaseUrl({ OMB_IPAD_WDA_URL: "http://192.168.1.20:8100" })).toThrow(/loopback/);
  });
});

describe("flattenSource", () => {
  it("returns visible, non-empty elements depth-first with rects in points", () => {
    const root = el("Application", {
      children: [
        el("Button", { label: "Done", rect: { x: 10, y: 20, width: 30, height: 40 } }),
        el("Other", { isVisible: "0", label: "hidden" }),
        el("Other", { rect: { x: 0, y: 0, width: 0, height: 10 }, label: "flat" }),
        el("Cell", { name: "row", children: [el("StaticText", { value: "Hello" })] }),
      ],
    });
    expect(flattenSource(root)).toEqual([
      { type: "Application", label: "", name: "", value: "", rect: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "Button", label: "Done", name: "", value: "", rect: { x: 10, y: 20, width: 30, height: 40 } },
      { type: "Cell", label: "", name: "row", value: "", rect: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "StaticText", label: "", name: "", value: "Hello", rect: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
  });
  it("caps the list at MAX_ELEMENTS", () => {
    const root = el("Application", { children: Array.from({ length: 400 }, (_, i) => el("StaticText", { label: `t${i}` })) });
    expect(flattenSource(root)).toHaveLength(MAX_ELEMENTS);
    expect(flattenSource(root, 5)).toHaveLength(5);
  });
  it("tolerates junk input", () => {
    expect(flattenSource(null)).toEqual([]);
    expect(flattenSource({ value: 3 })).toEqual([]);
  });
});

describe("elementLines", () => {
  it("renders one line per element with centre coordinates", () => {
    const lines = elementLines([
      { type: "Button", label: "Done", name: "", value: "", rect: { x: 10, y: 20, width: 30, height: 40 } },
    ]);
    expect(lines).toBe('Button "Done" at (25,40) rect 10,20 30x40');
  });
  it("explains an empty screen", () => {
    expect(elementLines([])).toBe("No accessible iPad UI is visible.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: FAIL — cannot resolve `./ipad-proxy.ts`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// server/drivers/ipad-proxy.ts
// First-party iPad MCP server. It drives a physical iPad through Appium's
// WebDriverAgent (WDA), an XCTest runner started by scripts/ipad-wda.mjs and
// reached over USB via iproxy on loopback. Like the Android phone proxy it
// imports nothing from the rest of the server: bundle-server.mjs builds it
// as a standalone entry.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export const DEFAULT_WDA_URL = "http://127.0.0.1:8100";
export const MAX_ELEMENTS = 300;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** WDA must be reached over USB (iproxy) on loopback; the env override may
 * only move the port. A LAN or Tailscale WDA would let any peer drive the
 * iPad, so it is refused outright. */
export function wdaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMB_IPAD_WDA_URL?.trim() || DEFAULT_WDA_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OMB_IPAD_WDA_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("OMB_IPAD_WDA_URL must be an http loopback address; WebDriverAgent is only reachable over USB");
  }
  return url.origin;
}

export type ScreenElement = {
  type: string;
  label: string;
  name: string;
  value: string;
  rect: { x: number; y: number; width: number; height: number };
};

const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/** Flatten WDA's `/source?format=json` tree into the visible elements a
 * model can target. A node is skipped when hidden (`isVisible === "0"`) or
 * zero-sized; its children are still visited with their own flags. */
export function flattenSource(root: unknown, limit = MAX_ELEMENTS): ScreenElement[] {
  const out: ScreenElement[] = [];
  const visit = (node: unknown) => {
    if (out.length >= limit || !node || typeof node !== "object") return;
    const raw = node as Json;
    const rect = (raw.rect ?? {}) as Json;
    const element: ScreenElement = {
      type: str(raw.type).replace(/^XCUIElementType/, ""),
      label: str(raw.label),
      name: str(raw.name),
      value: str(raw.value),
      rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    };
    const visible = str(raw.isVisible) !== "0" && element.rect.width > 0 && element.rect.height > 0;
    if (visible && element.type) out.push(element);
    for (const child of Array.isArray(raw.children) ? raw.children : []) visit(child);
  };
  visit(root);
  return out;
}

export function elementLines(elements: ScreenElement[]): string {
  if (!elements.length) return "No accessible iPad UI is visible.";
  return elements.map((e) => {
    const text = e.label || e.name || e.value;
    const { x, y, width, height } = e.rect;
    const cx = Math.round(x + width / 2);
    const cy = Math.round(y + height / 2);
    return `${e.type}${text ? ` ${JSON.stringify(text)}` : ""} at (${cx},${cy}) rect ${x},${y} ${width}x${height}`;
  }).join("\n");
}

// The stdio loop is added in Task 4; this guard keeps `import` side-effect free.
if (process.argv[1] && existsSync(process.argv[1]) && /ipad-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  createInterface({ input: process.stdin, terminal: false });
}
```

Note the test expects the hidden `Other` node to be dropped but not its siblings, and the `Cell` child `StaticText` to appear after the `Cell`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/drivers/ipad-proxy.ts server/drivers/ipad-proxy.test.ts
git commit -m "feat(ipad): proxy core — loopback URL policy and accessibility source flattening

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Action builders, app lookup, text matching and argument validation

**Files:**
- Modify: `server/drivers/ipad-proxy.ts`
- Test: `server/drivers/ipad-proxy.test.ts`

**Interfaces:**
- Consumes: `ScreenElement` from Task 1.
- Produces: `tapActions(x: number, y: number): Json`, `swipeActions(direction: SwipeDirection, size: { width: number; height: number }): Json`, `type SwipeDirection = "up" | "down" | "left" | "right"`, `KNOWN_APPS: Record<string, string>`, `resolveApp(name: string): string | null`, `findByText(elements: ScreenElement[], query: string, exact: boolean, index: number): ScreenElement | null`, `validatePoint(x: unknown, y: unknown, size: { width: number; height: number }): { x: number; y: number }`, `validateText(text: unknown): string`, `MAX_TEXT = 512`.

- [ ] **Step 1: Write the failing tests** (append to the test file; extend the import list)

```ts
import {
  KNOWN_APPS, MAX_TEXT, findByText, resolveApp, swipeActions, tapActions, validatePoint, validateText,
} from "./ipad-proxy.ts";

describe("tapActions", () => {
  it("builds one W3C touch pointer sequence", () => {
    expect(tapActions(12.4, 30)).toEqual({
      actions: [{
        type: "pointer", id: "finger1", parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: 12, y: 30 },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 80 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
  });
});

describe("swipeActions", () => {
  it("drags across the middle half of the screen", () => {
    const size = { width: 1000, height: 800 };
    const up = swipeActions("up", size).actions as Array<{ actions: Array<Record<string, unknown>> }>;
    expect(up[0].actions[0]).toEqual({ type: "pointerMove", duration: 0, x: 500, y: 600 });
    expect(up[0].actions[2]).toEqual({ type: "pointerMove", duration: 300, x: 500, y: 200 });
    const left = swipeActions("left", size).actions as Array<{ actions: Array<Record<string, unknown>> }>;
    expect(left[0].actions[0]).toEqual({ type: "pointerMove", duration: 0, x: 750, y: 400 });
    expect(left[0].actions[2]).toEqual({ type: "pointerMove", duration: 300, x: 250, y: 400 });
  });
});

describe("resolveApp", () => {
  it("maps Apple app names case-insensitively", () => {
    expect(resolveApp("Notes")).toBe("com.apple.mobilenotes");
    expect(resolveApp("safari")).toBe("com.apple.mobilesafari");
    expect(resolveApp("App Store")).toBe("com.apple.AppStore");
  });
  it("passes raw bundle ids through and rejects unknown names", () => {
    expect(resolveApp("com.example.thing")).toBe("com.example.thing");
    expect(resolveApp("Fortnite")).toBeNull();
    expect(resolveApp("")).toBeNull();
  });
  it("covers every app the spec lists", () => {
    for (const name of ["safari", "notes", "settings", "mail", "messages", "photos", "files", "calendar", "maps", "music", "reminders", "app store", "freeform", "clock", "camera", "books", "podcasts", "shortcuts"]) {
      expect(KNOWN_APPS[name], name).toMatch(/^com\.apple\./);
    }
  });
});

describe("findByText", () => {
  const els = [
    { type: "Button", label: "Done", name: "", value: "", rect: { x: 0, y: 0, width: 10, height: 10 } },
    { type: "StaticText", label: "", name: "Done deal", value: "", rect: { x: 0, y: 20, width: 10, height: 10 } },
    { type: "TextField", label: "", name: "", value: "done", rect: { x: 0, y: 40, width: 10, height: 10 } },
  ];
  it("matches label, name, or value case-insensitively by substring", () => {
    expect(findByText(els, "done", false, 0)?.type).toBe("Button");
    expect(findByText(els, "done", false, 2)?.type).toBe("TextField");
  });
  it("honours exact and returns null when nothing matches", () => {
    expect(findByText(els, "done", true, 1)?.type).toBe("TextField");
    expect(findByText(els, "done deal", true, 0)?.type).toBe("StaticText");
    expect(findByText(els, "nope", false, 0)).toBeNull();
  });
});

describe("validation", () => {
  const size = { width: 1024, height: 768 };
  it("rounds in-bounds points and rejects the rest", () => {
    expect(validatePoint(10.6, 20.2, size)).toEqual({ x: 11, y: 20 });
    expect(() => validatePoint(-1, 0, size)).toThrow(/outside/);
    expect(() => validatePoint(1025, 0, size)).toThrow(/outside/);
    expect(() => validatePoint("a", 0, size)).toThrow(/outside/);
  });
  it("accepts printable text up to MAX_TEXT and rejects control characters", () => {
    expect(validateText("Hello, world! 123")).toBe("Hello, world! 123");
    expect(validateText("a".repeat(MAX_TEXT))).toHaveLength(MAX_TEXT);
    expect(() => validateText("")).toThrow(/1 to 512/);
    expect(() => validateText("a".repeat(MAX_TEXT + 1))).toThrow(/1 to 512/);
    expect(() => validateText("line\nbreak")).toThrow(/printable/);
    expect(() => validateText(42)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Write the implementation** (insert before the argv guard)

```ts
export const MAX_TEXT = 512;
export type SwipeDirection = "up" | "down" | "left" | "right";
const SWIPE_DIRECTIONS = new Set<SwipeDirection>(["up", "down", "left", "right"]);

function touchSequence(steps: Json[]): Json {
  return { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: steps }] };
}

/** A real touch at a point: press, hold briefly, release. */
export function tapActions(x: number, y: number): Json {
  return touchSequence([
    { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 80 },
    { type: "pointerUp", button: 0 },
  ]);
}

/** Drag across the middle 50% of the screen in 300 ms. "up" moves the finger
 * from 75% to 25% height, i.e. scrolls content up like a person would. */
export function swipeActions(direction: SwipeDirection, size: { width: number; height: number }): Json {
  const { width, height } = size;
  const paths: Record<SwipeDirection, [number, number, number, number]> = {
    up: [width / 2, height * 0.75, width / 2, height * 0.25],
    down: [width / 2, height * 0.25, width / 2, height * 0.75],
    left: [width * 0.75, height / 2, width * 0.25, height / 2],
    right: [width * 0.25, height / 2, width * 0.75, height / 2],
  };
  const [x1, y1, x2, y2] = paths[direction].map(Math.round);
  return touchSequence([
    { type: "pointerMove", duration: 0, x: x1, y: y1 },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 300, x: x2, y: y2 },
    { type: "pointerUp", button: 0 },
  ]);
}

export const KNOWN_APPS: Record<string, string> = {
  "app store": "com.apple.AppStore",
  books: "com.apple.iBooks",
  calendar: "com.apple.mobilecal",
  camera: "com.apple.camera",
  clock: "com.apple.mobiletimer",
  files: "com.apple.DocumentsApp",
  freeform: "com.apple.freeform",
  mail: "com.apple.mobilemail",
  maps: "com.apple.Maps",
  messages: "com.apple.MobileSMS",
  music: "com.apple.Music",
  notes: "com.apple.mobilenotes",
  photos: "com.apple.mobileslideshow",
  podcasts: "com.apple.podcasts",
  reminders: "com.apple.reminders",
  safari: "com.apple.mobilesafari",
  settings: "com.apple.Preferences",
  shortcuts: "com.apple.shortcuts",
};
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Human name → bundle id via the built-in Apple map; a raw bundle id passes
 * through. Unknown names return null so the tool can suggest tap_text. */
export function resolveApp(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (KNOWN_APPS[key]) return KNOWN_APPS[key];
  return BUNDLE_ID.test(name.trim()) ? name.trim() : null;
}

export function findByText(elements: ScreenElement[], query: string, exact: boolean, index: number): ScreenElement | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const hits = elements.filter((e) =>
    [e.label, e.name, e.value].filter(Boolean).map((v) => v.toLowerCase()).some((v) => (exact ? v === needle : v.includes(needle))),
  );
  return hits[index] ?? null;
}

export function validatePoint(x: unknown, y: unknown, size: { width: number; height: number }): { x: number; y: number } {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > size.width || py > size.height) {
    throw new Error(`Point is outside the ${size.width}x${size.height} point screen (x and y must be numbers in points)`);
  }
  return { x: Math.round(px), y: Math.round(py) };
}

export function validateText(text: unknown): string {
  if (typeof text !== "string") throw new Error("text must be a string");
  if (text.length < 1 || text.length > MAX_TEXT) throw new Error(`text must be 1 to ${MAX_TEXT} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(text)) throw new Error("text must be printable (no control characters or line breaks); use press enter for a new line");
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/ipad-proxy.ts server/drivers/ipad-proxy.test.ts
git commit -m "feat(ipad): touch action builders, Apple app map, text matching and validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: WDA client with timeouts, lazy session and one invalid-session retry

**Files:**
- Modify: `server/drivers/ipad-proxy.ts`
- Test: `server/drivers/ipad-proxy.test.ts`

**Interfaces:**
- Consumes: `wdaBaseUrl` from Task 1.
- Produces:
  ```ts
  export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
  export interface WdaClient {
    get(path: string, timeoutMs?: number): Promise<unknown>;           // returns response.value
    post(path: string, body: Json, timeoutMs?: number): Promise<unknown>;
    session(method: "GET" | "POST", path: string, body?: Json, timeoutMs?: number): Promise<unknown>; // prefixes /session/<id>
    reachable(): Promise<boolean>;
  }
  export function createWdaClient(options: { fetch: FetchLike; baseUrl: string; defaultTimeoutMs?: number }): WdaClient;
  export class WdaUnreachable extends Error {}
  export const START_HINT: string;
  ```

- [ ] **Step 1: Write the failing tests** (append; extend imports)

```ts
import { START_HINT, WdaUnreachable, createWdaClient, type FetchLike } from "./ipad-proxy.ts";

type Route = (body: unknown) => { status?: number; value: unknown };
function fakeWda(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const route = routes[key];
    if (!route) return { status: 404, json: async () => ({ value: { error: "unknown command", message: key } }) };
    const result = route(body);
    return { status: result.status ?? 200, json: async () => ({ value: result.value, sessionId: "S1" }) };
  };
  return { fetch, calls };
}

describe("createWdaClient", () => {
  it("returns the value of a plain GET", async () => {
    const wda = fakeWda({ "GET /status": () => ({ value: { ready: true } }) });
    const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
    await expect(client.get("/status")).resolves.toEqual({ ready: true });
    expect(wda.calls[0].path).toBe("/status");
  });

  it("creates a session lazily once and reuses it", async () => {
    const wda = fakeWda({
      "POST /session": () => ({ value: { sessionId: "S1" } }),
      "GET /session/S1/window/size": () => ({ value: { width: 1024, height: 768 } }),
    });
    const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
    await client.session("GET", "/window/size");
    await client.session("GET", "/window/size");
    expect(wda.calls.filter((c) => c.path === "/session")).toHaveLength(1);
    expect(wda.calls[0].body).toEqual({ capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  });

  it("recreates the session exactly once after invalid session id", async () => {
    let sessions = 0;
    const wda = fakeWda({
      "POST /session": () => ({ value: { sessionId: `S${++sessions}` } }),
      "GET /session/S1/window/size": () => ({ status: 404, value: { error: "invalid session id", message: "gone" } }),
      "GET /session/S2/window/size": () => ({ value: { width: 1, height: 2 } }),
    });
    const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
    await expect(client.session("GET", "/window/size")).resolves.toEqual({ width: 1, height: 2 });
    expect(sessions).toBe(2);
  });

  it("surfaces other WDA errors with their message and gives up after one retry", async () => {
    let sessions = 0;
    const wda = fakeWda({
      "POST /session": () => ({ value: { sessionId: `S${++sessions}` } }),
      "POST /session/S1/wda/apps/launch": () => ({ status: 400, value: { error: "invalid argument", message: "no such app" } }),
      "GET /session/S1/window/size": () => ({ status: 404, value: { error: "invalid session id", message: "gone" } }),
      "GET /session/S2/window/size": () => ({ status: 404, value: { error: "invalid session id", message: "gone again" } }),
    });
    const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
    await expect(client.session("POST", "/wda/apps/launch", { bundleId: "x" })).rejects.toThrow(/no such app/);
    await expect(client.session("GET", "/window/size")).rejects.toThrow(/gone again/);
    expect(sessions).toBe(2);
  });

  it("turns connection failures into WdaUnreachable carrying the start hint", async () => {
    const fetch: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const client = createWdaClient({ fetch, baseUrl: "http://127.0.0.1:8100" });
    await expect(client.get("/status")).rejects.toBeInstanceOf(WdaUnreachable);
    await expect(client.get("/status")).rejects.toThrow(START_HINT);
    await expect(client.reachable()).resolves.toBe(false);
  });

  it("aborts a call that exceeds its timeout", async () => {
    const fetch: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const client = createWdaClient({ fetch, baseUrl: "http://127.0.0.1:8100", defaultTimeoutMs: 20 });
    await expect(client.get("/status")).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: FAIL — `createWdaClient` is not exported.

- [ ] **Step 3: Write the implementation** (insert before the argv guard)

```ts
export const DEFAULT_TIMEOUT_MS = 15_000;
export const SLOW_TIMEOUT_MS = 30_000;
export const START_HINT = "WebDriverAgent is not running on the iPad. On the Mac, plug the iPad in over USB and run: pnpm ipad:wda";

export class WdaUnreachable extends Error {}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface WdaClient {
  get(path: string, timeoutMs?: number): Promise<unknown>;
  post(path: string, body: Json, timeoutMs?: number): Promise<unknown>;
  session(method: "GET" | "POST", path: string, body?: Json, timeoutMs?: number): Promise<unknown>;
  reachable(): Promise<boolean>;
}

class WdaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function createWdaClient({ fetch, baseUrl, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }: { fetch: FetchLike; baseUrl: string; defaultTimeoutMs?: number }): WdaClient {
  let sessionId: string | null = null;

  async function call(method: "GET" | "POST", path: string, body?: Json, timeoutMs = defaultTimeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`WebDriverAgent call ${method} ${path} timed out after ${timeoutMs} ms`);
      throw new WdaUnreachable(`${START_HINT} (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      clearTimeout(timer);
    }
    const payload = (await response.json().catch(() => ({}))) as Json;
    const value = payload.value;
    if (response.status >= 400 || (value && typeof value === "object" && typeof (value as Json).error === "string")) {
      const detail = (value && typeof value === "object" ? (value as Json) : {}) as Json;
      throw new WdaError(str(detail.error) || `http ${response.status}`, str(detail.message) || str(detail.error) || `WebDriverAgent returned HTTP ${response.status}`);
    }
    return value;
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const value = (await call("POST", "/session", { capabilities: { alwaysMatch: {}, firstMatch: [{}] } })) as Json;
    const id = str(value?.sessionId);
    if (!id) throw new Error("WebDriverAgent did not return a session id");
    sessionId = id;
    return id;
  }

  return {
    get: (path, timeoutMs) => call("GET", path, undefined, timeoutMs),
    post: (path, body, timeoutMs) => call("POST", path, body, timeoutMs),
    async session(method, path, body, timeoutMs) {
      for (let attempt = 0; ; attempt++) {
        const id = await ensureSession();
        try {
          return await call(method, `/session/${id}${path}`, body, timeoutMs);
        } catch (error) {
          if (error instanceof WdaError && error.code === "invalid session id" && attempt === 0) {
            sessionId = null;
            continue;
          }
          throw error;
        }
      }
    },
    async reachable() {
      try {
        await call("GET", "/status");
        return true;
      } catch (error) {
        if (error instanceof WdaUnreachable) return false;
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/ipad-proxy.ts server/drivers/ipad-proxy.test.ts
git commit -m "feat(ipad): WebDriverAgent client with timeouts, lazy session, one invalid-session retry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Tool runner, TOOLS table and the stdio MCP loop

**Files:**
- Modify: `server/drivers/ipad-proxy.ts`
- Test: `server/drivers/ipad-proxy.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  ```ts
  export type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
  export type Downscale = (png: Buffer, widthPoints: number) => Promise<Buffer>;
  export const TOOLS: readonly { name: string; description: string; inputSchema: Json }[];
  export function createToolRunner(options: { client: WdaClient; downscale: Downscale }): (name: string, args: Json) => Promise<ToolResult>;
  export function sipsDownscale(png: Buffer, widthPoints: number): Promise<Buffer>;  // macOS sips, falls back to input
  ```

- [ ] **Step 1: Write the failing tests** (append; extend imports)

```ts
import { TOOLS, createToolRunner, type Downscale } from "./ipad-proxy.ts";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function runnerWith(extraRoutes: Record<string, Route> = {}, downscale: Downscale = async (png) => png) {
  const source = {
    type: "XCUIElementTypeApplication", label: "", name: "Notes", value: "", isVisible: "1", rect: { x: 0, y: 0, width: 1024, height: 768 },
    children: [
      { type: "XCUIElementTypeButton", label: "New Note", name: "", value: "", isVisible: "1", rect: { x: 900, y: 10, width: 100, height: 40 }, children: [] },
      { type: "XCUIElementTypeSecureTextField", label: "Password", name: "", value: "", isVisible: "0", rect: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
    ],
  };
  const wda = fakeWda({
    "GET /status": () => ({ value: { ready: true, os: { name: "iPadOS", version: "26.0" }, device: "ipad" } }),
    "POST /session": () => ({ value: { sessionId: "S1" } }),
    "GET /session/S1/window/size": () => ({ value: { width: 1024, height: 768 } }),
    "GET /session/S1/wda/screen": () => ({ value: { scale: 2, statusBarSize: { width: 1024, height: 24 } } }),
    "GET /source?format=json": () => ({ value: source }),
    "GET /screenshot": () => ({ value: PNG_1X1.toString("base64") }),
    "POST /session/S1/wda/apps/launch": () => ({ value: null }),
    "POST /session/S1/wda/keys": () => ({ value: null }),
    "POST /session/S1/wda/homescreen": () => ({ value: null }),
    "POST /session/S1/actions": () => ({ value: null }),
    ...extraRoutes,
  });
  const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
  return { run: createToolRunner({ client, downscale }), calls: wda.calls };
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

describe("TOOLS", () => {
  it("exposes the nine phone-shaped tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["status", "read_screen", "screenshot", "open_app", "tap_text", "tap", "swipe", "type_text", "press"]);
  });
});

describe("createToolRunner", () => {
  it("status reports the device, size and scale when reachable", async () => {
    const { run } = runnerWith();
    const out = JSON.parse(text(await run("status", {})));
    expect(out).toMatchObject({ available: true, os: "iPadOS 26.0", screen: { width: 1024, height: 768, scale: 2 } });
  });

  it("status explains how to start WDA when unreachable, without isError", async () => {
    const client = createWdaClient({ fetch: async () => { throw new Error("ECONNREFUSED"); }, baseUrl: "http://127.0.0.1:8100" });
    const run = createToolRunner({ client, downscale: async (png) => png });
    const result = await run("status", {});
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("pnpm ipad:wda");
    expect(JSON.parse(text(result)).available).toBe(false);
  });

  it("read_screen lists visible elements only", async () => {
    const { run } = runnerWith();
    const lines = text(await run("read_screen", {}));
    expect(lines).toContain('Button "New Note" at (950,30) rect 900,10 100x40');
    expect(lines).not.toContain("Password");
  });

  it("screenshot downscales to the point width and returns a PNG", async () => {
    const seen: number[] = [];
    const { run } = runnerWith({}, async (png, width) => { seen.push(width); return png; });
    const result = await run("screenshot", {});
    expect(seen).toEqual([1024]);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG_1X1.toString("base64") });
    expect(text(result)).toContain("1024x768 points");
  });

  it("open_app launches a known name or bundle id and hints on unknown names", async () => {
    const { run, calls } = runnerWith();
    expect(text(await run("open_app", { name: "Notes" }))).toBe("Opened Notes (com.apple.mobilenotes)");
    expect(calls.find((c) => c.path === "/session/S1/wda/apps/launch")?.body).toEqual({ bundleId: "com.apple.mobilenotes" });
    expect(text(await run("open_app", { name: "org.mozilla.ios.Firefox" }))).toContain("org.mozilla.ios.Firefox");
    const unknown = await run("open_app", { name: "Fortnite" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/tap_text/);
  });

  it("tap_text touches the centre of the match", async () => {
    const { run, calls } = runnerWith();
    expect(text(await run("tap_text", { text: "new note" }))).toBe('Tapped "New Note"');
    const actions = calls.find((c) => c.path === "/session/S1/actions")?.body as { actions: Array<{ actions: Array<Record<string, unknown>> }> };
    expect(actions.actions[0].actions[0]).toMatchObject({ x: 950, y: 30 });
  });

  it("tap validates against the screen size", async () => {
    const { run } = runnerWith();
    expect(text(await run("tap", { x: 100, y: 200 }))).toBe("Tapped 100,200");
    const bad = await run("tap", { x: 5000, y: 0 });
    expect(bad.isError).toBe(true);
  });

  it("swipe, type_text and press hit the right WDA routes", async () => {
    const { run, calls } = runnerWith();
    expect(text(await run("swipe", { direction: "up" }))).toBe("Swiped up");
    expect(text(await run("type_text", { text: "hello" }))).toBe("Typed text into the focused iPad field");
    expect(calls.find((c) => c.path === "/session/S1/wda/keys")?.body).toEqual({ value: ["hello"] });
    expect(text(await run("press", { key: "home" }))).toBe("Pressed home");
    expect(calls.some((c) => c.path === "/session/S1/wda/homescreen")).toBe(true);
    expect(text(await run("press", { key: "enter" }))).toBe("Pressed enter");
    expect(calls.filter((c) => c.path === "/session/S1/wda/keys").at(-1)?.body).toEqual({ value: ["\n"] });
    const bad = await run("press", { key: "volume" });
    expect(bad.isError).toBe(true);
  });

  it("unknown tools and WDA failures come back as isError results", async () => {
    const { run } = runnerWith({ "POST /session/S1/wda/apps/launch": () => ({ status: 400, value: { error: "invalid argument", message: "no such app" } }) });
    expect((await run("nope", {})).isError).toBe(true);
    const failed = await run("open_app", { name: "Notes" });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("no such app");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts`
Expected: FAIL — `TOOLS`/`createToolRunner` not exported.

- [ ] **Step 3: Write the implementation**

Replace the placeholder argv guard at the bottom of the file with the block below, and add these imports at the top: `import { spawn } from "node:child_process";`, `import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";`, `import { tmpdir } from "node:os";`, `import { join } from "node:path";`.

```ts
export type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
export type Downscale = (png: Buffer, widthPoints: number) => Promise<Buffer>;

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

const PRESS_KEYS: Record<string, { keys: string } | { home: true }> = {
  delete: { keys: "\b" },
  enter: { keys: "\n" },
  home: { home: true },
  return: { keys: "\n" },
  space: { keys: " " },
  tab: { keys: "\t" },
};

export const TOOLS = [
  { name: "status", description: "Check that WebDriverAgent is running on the USB-connected iPad before any iPad task. Reports the screen size in points.", inputSchema: { type: "object", properties: {} } },
  { name: "read_screen", description: "Read visible accessibility elements (type, label, value, centre point and rect in points) from the iPad screen. Use after every action to verify the result.", inputSchema: { type: "object", properties: {} } },
  { name: "screenshot", description: "Capture the iPad screen when accessibility text is insufficient. Returns a PNG whose pixels equal points, so its coordinates can be passed to tap.", inputSchema: { type: "object", properties: {} } },
  { name: "open_app", description: "Open an app by its human name (Safari, Notes, Settings, Mail, Messages, Photos, Files, Calendar, Maps, Music, Reminders, App Store, Freeform, Clock, Camera, Books, Podcasts, Shortcuts) or by bundle id. For other apps, press home and use tap_text on the icon.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "tap_text", description: "Tap visible iPad text or an accessibility label, then use read_screen to verify.", inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, index: { type: "integer", minimum: 0 } }, required: ["text"] } },
  { name: "tap", description: "Tap iPad screen coordinates in points obtained from read_screen or screenshot.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "swipe", description: "Swipe the iPad screen in a direction, then use read_screen to verify.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } }, required: ["direction"] } },
  { name: "type_text", description: "Type printable text into the focused iPad field. Never enter passwords, payment details, or one-time codes.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT } }, required: ["text"] } },
  { name: "press", description: "Press an iPad key: home, enter, delete, tab, or space.", inputSchema: { type: "object", properties: { key: { type: "string", enum: Object.keys(PRESS_KEYS) } }, required: ["key"] } },
] as const;

/** Downscale with macOS sips so screenshot pixels equal points. Any failure
 * (non-macOS, sips missing) returns the original bytes. */
export async function sipsDownscale(png: Buffer, widthPoints: number): Promise<Buffer> {
  if (process.platform !== "darwin") return png;
  const dir = await mkdtemp(join(tmpdir(), "omb-ipad-"));
  const file = join(dir, "shot.png");
  try {
    await writeFile(file, png);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("sips", ["--resampleWidth", String(Math.round(widthPoints)), file], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    return ok ? await readFile(file) : png;
  } catch {
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createToolRunner({ client, downscale }: { client: WdaClient; downscale: Downscale }): (name: string, args: Json) => Promise<ToolResult> {
  const screenSize = async () => {
    const size = (await client.session("GET", "/window/size")) as Json;
    return { width: num(size?.width), height: num(size?.height) };
  };
  const elements = async () => flattenSource(await client.get("/source?format=json", SLOW_TIMEOUT_MS));

  async function callTool(name: string, args: Json): Promise<ToolResult> {
    if (name === "status") {
      if (!(await client.reachable())) return textResult(JSON.stringify({ available: false, instruction: START_HINT }, null, 2));
      const status = (await client.get("/status")) as Json;
      const os = (status?.os ?? {}) as Json;
      const size = await screenSize();
      const screen = (await client.session("GET", "/wda/screen")) as Json;
      return textResult(JSON.stringify({ available: true, device: str(status?.device) || "ipad", os: `${str(os.name) || "iPadOS"} ${str(os.version)}`.trim(), screen: { ...size, scale: num(screen?.scale) || 1 } }, null, 2));
    }
    if (name === "read_screen") return textResult(elementLines(await elements()));
    if (name === "screenshot") {
      const size = await screenSize();
      const raw = Buffer.from(str(await client.get("/screenshot", SLOW_TIMEOUT_MS)), "base64");
      if (!raw.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("WebDriverAgent returned an invalid screenshot");
      const png = await downscale(raw, size.width);
      return { content: [{ type: "text", text: `iPad screenshot, ${size.width}x${size.height} points (pixels equal points)` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }
    if (name === "open_app") {
      const appName = String(args.name ?? "").trim();
      if (!appName) throw new Error("name is required");
      const bundleId = resolveApp(appName);
      if (!bundleId) throw new Error(`Unknown app ${JSON.stringify(appName)}: give its bundle id, or press home and use tap_text on its icon`);
      await client.session("POST", "/wda/apps/launch", { bundleId });
      return textResult(`Opened ${appName} (${bundleId})`);
    }
    if (name === "tap_text") {
      const hit = findByText(await elements(), String(args.text ?? ""), args.exact === true, Number.isInteger(args.index) ? Number(args.index) : 0);
      if (!hit) throw new Error(`No visible iPad text matches ${JSON.stringify(args.text)}`);
      const { x, y, width, height } = hit.rect;
      await client.session("POST", "/actions", tapActions(x + width / 2, y + height / 2));
      return textResult(`Tapped ${JSON.stringify(hit.label || hit.name || hit.value)}`);
    }
    if (name === "tap") {
      const point = validatePoint(args.x, args.y, await screenSize());
      await client.session("POST", "/actions", tapActions(point.x, point.y));
      return textResult(`Tapped ${point.x},${point.y}`);
    }
    if (name === "swipe") {
      const direction = String(args.direction ?? "") as SwipeDirection;
      if (!SWIPE_DIRECTIONS.has(direction)) throw new Error("direction must be up, down, left, or right");
      await client.session("POST", "/actions", swipeActions(direction, await screenSize()));
      return textResult(`Swiped ${direction}`);
    }
    if (name === "type_text") {
      await client.session("POST", "/wda/keys", { value: [validateText(args.text)] });
      return textResult("Typed text into the focused iPad field");
    }
    if (name === "press") {
      const key = String(args.key ?? "").toLowerCase();
      const action = PRESS_KEYS[key];
      if (!action) throw new Error("key must be one of home, enter, delete, tab, space");
      if ("home" in action) await client.session("POST", "/wda/homescreen", {});
      else await client.session("POST", "/wda/keys", { value: [action.keys] });
      return textResult(`Pressed ${key}`);
    }
    throw new Error(`Unknown ipad tool: ${name}`);
  }

  return async (name, args) => {
    try {
      return await callTool(name, args);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  };
}

const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

if (process.argv[1] && existsSync(process.argv[1]) && /ipad-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const runTool = createToolRunner({
    client: createWdaClient({ fetch: fetch as unknown as FetchLike, baseUrl: wdaBaseUrl() }),
    downscale: sipsDownscale,
  });
  const handle = async (message: Json) => {
    const id = message.id;
    const method = message.method;
    const params = (message.params ?? {}) as Json;
    if (method === "initialize") return ok(id, { protocolVersion: String(params.protocolVersion ?? "2024-11-05"), capabilities: { tools: {} }, serverInfo: { name: "openmausbot-ipad", version: "1" } });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: TOOLS });
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return ok(id, await runTool(name, (params.arguments ?? {}) as Json));
    }
    if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
  };
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      void handle(message).catch((error) => rpcError(message.id, -32603, error instanceof Error ? error.message : String(error)));
    } catch {}
  });
}
```

`wdaBaseUrl()` throwing at startup (bad env) is acceptable: the proxy exits and the driver reports the server failed to start, which the docs cover.

- [ ] **Step 4: Run the tests and the type-check**

Run: `pnpm exec vitest run server/drivers/ipad-proxy.test.ts && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Smoke the stdio surface by hand**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}' | node --experimental-strip-types server/drivers/ipad-proxy.ts
```
Expected: three JSON lines; the third contains `"available": false` and the `pnpm ipad:wda` hint (WDA is not running yet).

- [ ] **Step 6: Commit**

```bash
git add server/drivers/ipad-proxy.ts server/drivers/ipad-proxy.test.ts
git commit -m "feat(ipad): tool runner, TOOLS table and stdio MCP loop for the iPad proxy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Server wiring — proxy path, bundle entry, reserved name, capability, driver mounts

**Files:**
- Modify: `server/proxy-paths.ts:46` (SPAWNED_PROXIES), `server/proxy-paths.test.ts`
- Modify: `scripts/bundle-server.mjs:64` (ENTRY_POINTS)
- Modify: `server/mcp-registry.ts:41-50`, `server/mcp-registry.test.ts:23-26`
- Modify: `server/contracts.ts:303` (integrations) and `:365` (capabilities)
- Modify: `server/drivers/claude.ts:1157-1160` (mount) and `:1990` (capability)
- Modify: `server/drivers/codex.ts:678-688` (mount) and `:1511` (capability)
- Modify: `server/drivers/pi.ts:115` (mount) and `:894` (capability)
- Modify: `server/harness/registry.ts:252`

**Interfaces:**
- Consumes: the proxy file from Task 4.
- Produces: `SPAWNED_PROXIES.ipad`, `TurnRequest.integrations.ipad?: { command; args; env }`, `capabilities.ipadMcp?: boolean`, and every driver mounting server name `ipad` (Claude allow-lists `mcp__ipad`; Codex config prefix `mcp_servers.openmausbot_ipad`).

- [ ] **Step 1: Write the failing tests**

Append to `server/proxy-paths.test.ts` inside the existing `describe`:
```ts
  it("resolves the iPad proxy next to the phone proxy", () => {
    expect(SPAWNED_PROXIES.ipad).toBe(join(SERVER_ROOT, "drivers", "ipad-proxy.ts"));
    expect(existsSync(SPAWNED_PROXIES.ipad)).toBe(true);
  });
```
In `server/mcp-registry.test.ts`, inside the "refuses unsafe and reserved routing names" test, add:
```ts
    expect(mcpServerNameError("ipad")).toMatch(/reserved/);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/proxy-paths.test.ts server/mcp-registry.test.ts`
Expected: FAIL — `SPAWNED_PROXIES.ipad` is undefined; `"ipad"` is accepted.

- [ ] **Step 3: Make the edits**

`server/proxy-paths.ts`, after the `phone:` line:
```ts
  ipad: resolveProxy("drivers/ipad-proxy"),
```

`scripts/bundle-server.mjs`, after `"drivers/phone-proxy.ts",`:
```js
  "drivers/ipad-proxy.ts",
```

`server/mcp-registry.ts`, in `RESERVED_MCP_NAMES` after `"phone",`:
```ts
  "ipad",
  "openmausbot_ipad",
```

`server/contracts.ts`, after the `phone?:` integration line:
```ts
    /** Physical iPad tools through WebDriverAgent over USB (loopback only). */
    ipad?: { command: string; args: string[]; env: Record<string, string> };
```
and after `phoneMcp?: boolean;`:
```ts
    /** True when the driver can mount the first-party iPad MCP. Same rule as
     * phoneMcp: never offer the iPad tools to a driver that cannot mount them. */
    ipadMcp?: boolean;
```

`server/drivers/claude.ts`, after the `turn.integrations?.phone` block:
```ts
      if (turn.integrations?.ipad) {
        mcpServers.ipad = { ...turn.integrations.ipad };
        allowed.push("mcp__ipad");
      }
```
and after `phoneMcp: true,` in the capabilities object: `ipadMcp: true,`.

`server/drivers/codex.ts`, after the `turn.integrations?.phone` block:
```ts
        if (turn.integrations?.ipad) {
          const bridge = turn.integrations.ipad;
          Object.assign(env, bridge.env);
          const prefix = "mcp_servers.openmausbot_ipad";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }
```
and after `phoneMcp: true,` in the capabilities object: `ipadMcp: true,`.

`server/drivers/pi.ts`, after the phone line:
```ts
  if (turn.integrations?.ipad) servers.ipad = { ...turn.integrations.ipad };
```
and after `phoneMcp: true,`: `ipadMcp: true,`.

`server/harness/registry.ts`, after the `phoneMcp:` line:
```ts
            ipadMcp: inst.adapter.capabilities.ipadMcp === true,
```

- [ ] **Step 4: Run the tests and type-check**

Run: `pnpm exec vitest run server/proxy-paths.test.ts server/mcp-registry.test.ts && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS. If `tsc` reports the registry's capabilities type lacks `ipadMcp`, add `ipadMcp: boolean` beside `phoneMcp` in that type (search `phoneMcp: boolean` under `server/harness/` and `shared/`).

- [ ] **Step 5: Commit**

```bash
git add server/proxy-paths.ts server/proxy-paths.test.ts scripts/bundle-server.mjs server/mcp-registry.ts server/mcp-registry.test.ts server/contracts.ts server/drivers/claude.ts server/drivers/codex.ts server/drivers/pi.ts server/harness/registry.ts
git commit -m "feat(ipad): wire the iPad proxy — spawned path, bundle entry, reserved name, ipadMcp capability, driver mounts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Bundled `ipad-harness` skill and turn mounting in index.ts

**Files:**
- Create: `skills/ipad-harness/manifest.json`, `skills/ipad-harness/SKILL.md`, `skills/ipad-harness/agents/openai.yaml`
- Modify: `server/index.ts:849-851` (proxy path), `:1225-1231` (integration factory), `:5605-5616` and `:7414-7427` (mount sites)
- Test: `server/skill-library.test.ts`

**Interfaces:**
- Consumes: `SPAWNED_PROXIES.ipad`, `integrations.ipad`, `capabilities.ipadMcp` from Task 5.
- Produces: `ipadIntegration(): { command: string; args: string[]; env: Record<string, string> }` in index.ts; the skill with `requiredCapabilities: ["ipadMcp"]`.

- [ ] **Step 1: Write the failing test** (append to `server/skill-library.test.ts`)

```ts
describe("bundled ipad-harness skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const ipad = skills.find((s) => s.manifest.id === "ipad-harness");
  it("is bundled with the ipadMcp capability", () => {
    expect(ipad?.manifest.requiredCapabilities).toEqual(["ipadMcp"]);
    expect(ipad?.manifest.defaultEnabled).toBe(true);
  });
  it("selects on iPad wording and not on phone wording", () => {
    const both = ["phoneMcp", "ipadMcp"];
    expect(selectBundledSkills("Open Notes on the iPad and write hello", both, skills).map((s) => s.manifest.id)).toEqual(["ipad-harness"]);
    expect(selectBundledSkills("Open Uber on my phone", both, skills).map((s) => s.manifest.id)).toEqual(["phone-harness"]);
    expect(selectBundledSkills("Open Notes on the iPad", ["phoneMcp"], skills)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run server/skill-library.test.ts`
Expected: FAIL — `ipad` is undefined.

- [ ] **Step 3: Create the skill**

`skills/ipad-harness/manifest.json`:
```json
{
  "id": "ipad-harness",
  "name": "iPad Harness",
  "version": "0.1.0",
  "description": "Control a physical iPad connected to this Mac over USB through WebDriverAgent.",
  "defaultEnabled": true,
  "triggerTerms": [
    "ipad",
    "ipados",
    "on the ipad",
    "ipad app",
    "ipad screen",
    "tablet"
  ],
  "requiredCapabilities": ["ipadMcp"]
}
```

`skills/ipad-harness/SKILL.md`:
```markdown
---
name: ipad-harness
description: "Control, inspect, test, or automate a physical iPad connected to this Mac over USB through WebDriverAgent. Use for explicit iPad, iPadOS, tablet, iPad-app, tapping, typing, swiping, scrolling, screenshot, or iPad-screen requests."
---

# iPad Harness

Use the `ipad` tools for every requested iPad action. Never replace them with
Bash, `xcrun`, `idevice*`, `curl` against WebDriverAgent, a simulator, or any
other automation route.

1. Call `status` before the first action. If WebDriverAgent is not running,
   stop and relay its instruction to the user; do not try to start it.
2. Call `open_app` with the human app name or bundle id. For apps it does not
   know, `press` home and `tap_text` the icon's name.
3. Call `read_screen` before choosing a target and after every action. Prefer
   `tap_text`; use `screenshot` and point `tap` only when accessibility text
   cannot identify the target. Screenshot pixels equal points.
4. Use `swipe`, `type_text`, and `press` for interaction, verifying each step.
   `type_text` goes to the focused field: tap the field first.

The tools operate the user's real iPad. Navigate and read only what the task
needs. Stop before sending, posting, purchasing, booking, deleting, changing
settings, entering protected information, or accepting an unexpected legal or
security prompt unless the user has explicitly authorized that exact action.

Never enter passwords, payment details, government identifiers, or one-time
codes. Ask the user to complete protected-input steps directly on the iPad.
Secure fields and protected content are invisible to these tools by design.
```

`skills/ipad-harness/agents/openai.yaml`:
```yaml
interface:
  display_name: "iPad Harness"
  short_description: "Control a USB-connected iPad"
  default_prompt: "Use $ipad-harness to open an app and complete a task on my connected iPad."

dependencies:
  tools:
    - type: "mcp"
      value: "ipad"
      description: "OpenMausBot's bundled physical iPad tools"

policy:
  allow_implicit_invocation: true
```

- [ ] **Step 4: Wire index.ts**

After `const phoneProxyPath = SPAWNED_PROXIES.phone;`:
```ts
const ipadProxyPath = SPAWNED_PROXIES.ipad;
```

After the `phoneIntegration()` function:
```ts
function ipadIntegration() {
  const env: Record<string, string> = { ...AGENTS_NODE_FLAG };
  if (process.env.OMB_IPAD_WDA_URL) env.OMB_IPAD_WDA_URL = process.env.OMB_IPAD_WDA_URL;
  return { command: process.execPath, args: [ipadProxyPath], env };
}
```

At the first mount site (around line 5605), change the capability array and add the mount:
```ts
        [
          ...(instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : []),
          ...(instance.adapter.capabilities.ipadMcp === true ? ["ipadMcp"] : []),
          ...(skillAuthoring ? ["skillAuthoring"] : []),
        ],
```
and after the phone mount block:
```ts
      if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("ipadMcp"))) {
        if (!claimTurnResource(resourceOwner, "computer:ipad")) throw new Error("another thread is using the iPad — wait for it to finish");
        integrations.ipad = ipadIntegration();
      }
```

At the second mount site (around line 7414), change the capability argument:
```ts
      [
        ...(instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : []),
        ...(instance.adapter.capabilities.ipadMcp === true ? ["ipadMcp"] : []),
      ],
```
and after the phone mount block:
```ts
  if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("ipadMcp"))) {
    if (!claimTurnResource(resourceOwner, "computer:ipad")) throw new Error("another thread is using the iPad — wait for it to finish");
    integrations.ipad = ipadIntegration();
  }
```

- [ ] **Step 5: Run the tests and type-check**

Run: `pnpm exec vitest run server/skill-library.test.ts server/proxy-paths.test.ts && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/ipad-harness server/index.ts server/skill-library.test.ts
git commit -m "feat(ipad): bundled ipad-harness skill and per-turn mounting behind computer:ipad

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Developer launcher `scripts/ipad-wda.mjs`, dependency, script and docs

**Files:**
- Create: `scripts/ipad-wda.mjs`, `scripts/ipad-wda.test.ts`, `docs/ipad-harness.md`
- Modify: `package.json` (devDependencies, scripts)

**Interfaces:**
- Produces: `wdaLaunchPlan({ udid, teamId, project, derivedData, port }): { build: string[]; test: string[]; env: Record<string, string>; iproxy: string[] }` and `pickIpad(devices: unknown): { udid: string; name: string } | null`, both exported from the `.mjs`; `pnpm ipad:wda`.

- [ ] **Step 1: Add the dependency and script**

Run: `pnpm add -D appium-webdriveragent@16.12.8`
If pnpm reports a blocked build script for the package, run `pnpm approve-builds` and approve only `appium-webdriveragent`, then re-run. Verify: `ls node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj` exists.

In `package.json` scripts, next to `"test:cua"`:
```json
    "ipad:wda": "node scripts/ipad-wda.mjs",
```

- [ ] **Step 2: Write the failing test**

```ts
// scripts/ipad-wda.test.ts
import { describe, expect, it } from "vitest";

import { pickIpad, wdaLaunchPlan } from "./ipad-wda.mjs";

describe("wdaLaunchPlan", () => {
  const plan = wdaLaunchPlan({ udid: "UDID-1", teamId: "R2J9MJAU6H", project: "/x/WebDriverAgent.xcodeproj", derivedData: "/x/dd", port: 8100 });
  it("builds for testing, then tests without building, signed with the team", () => {
    expect(plan.build).toEqual([
      "build-for-testing", "-project", "/x/WebDriverAgent.xcodeproj", "-scheme", "WebDriverAgentRunner",
      "-destination", "id=UDID-1", "-derivedDataPath", "/x/dd",
      "DEVELOPMENT_TEAM=R2J9MJAU6H", "CODE_SIGN_STYLE=Automatic", "PRODUCT_BUNDLE_IDENTIFIER=com.openmausbot.WebDriverAgentRunner",
      "-allowProvisioningUpdates",
    ]);
    expect(plan.test).toEqual([
      "test-without-building", "-project", "/x/WebDriverAgent.xcodeproj", "-scheme", "WebDriverAgentRunner",
      "-destination", "id=UDID-1", "-derivedDataPath", "/x/dd",
      "DEVELOPMENT_TEAM=R2J9MJAU6H", "CODE_SIGN_STYLE=Automatic", "PRODUCT_BUNDLE_IDENTIFIER=com.openmausbot.WebDriverAgentRunner",
    ]);
    expect(plan.env).toEqual({ USE_PORT: "8100" });
    expect(plan.iproxy).toEqual(["8100", "8100", "-u", "UDID-1"]);
  });
});

describe("pickIpad", () => {
  const devicectl = {
    result: {
      devices: [
        { hardwareProperties: { udid: "PHONE", deviceType: "iPhone" }, deviceProperties: { name: "Omkar's iPhone" }, connectionProperties: { pairingState: "paired" } },
        { hardwareProperties: { udid: "PAD", deviceType: "iPad" }, deviceProperties: { name: "Omkar's iPad" }, connectionProperties: { pairingState: "paired" } },
        { hardwareProperties: { udid: "PAD2", deviceType: "iPad" }, deviceProperties: { name: "Unpaired" }, connectionProperties: { pairingState: "unpaired" } },
      ],
    },
  };
  it("returns the first paired iPad", () => {
    expect(pickIpad(devicectl)).toEqual({ udid: "PAD", name: "Omkar's iPad" });
  });
  it("returns null when no paired iPad exists", () => {
    expect(pickIpad({ result: { devices: [devicectl.result.devices[0]] } })).toBeNull();
    expect(pickIpad(null)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run scripts/ipad-wda.test.ts`
Expected: FAIL — cannot resolve `./ipad-wda.mjs`.

- [ ] **Step 4: Write the launcher**

```js
// scripts/ipad-wda.mjs
// Developer launcher for the iPad harness. Builds Appium's WebDriverAgent
// runner from the pinned npm package, runs it on the USB-attached iPad, and
// forwards its port to loopback with iproxy so server/drivers/ipad-proxy.ts
// can reach it at http://127.0.0.1:8100. Not shipped in the packaged app.
//
//   pnpm ipad:wda                 # build once (cached in .omb-scratch), run
//   pnpm ipad:wda -- --rebuild    # force a rebuild
//   pnpm ipad:wda -- --udid X     # pick a device explicitly
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = join(ROOT, "node_modules", "appium-webdriveragent", "WebDriverAgent.xcodeproj");
const DERIVED = join(ROOT, ".omb-scratch", "wda-derived");
const RUNNER_ID = "com.openmausbot.WebDriverAgentRunner";

export function wdaLaunchPlan({ udid, teamId, project, derivedData, port }) {
  const common = [
    "-project", project, "-scheme", "WebDriverAgentRunner",
    "-destination", `id=${udid}`, "-derivedDataPath", derivedData,
    `DEVELOPMENT_TEAM=${teamId}`, "CODE_SIGN_STYLE=Automatic", `PRODUCT_BUNDLE_IDENTIFIER=${RUNNER_ID}`,
  ];
  return {
    build: ["build-for-testing", ...common, "-allowProvisioningUpdates"],
    test: ["test-without-building", ...common],
    // WDA's runner scheme forwards USE_PORT from xcodebuild's environment.
    env: { USE_PORT: String(port) },
    iproxy: [String(port), String(port), "-u", udid],
  };
}

/** First paired iPad in `xcrun devicectl list devices --json-output` output. */
export function pickIpad(devicectl) {
  const devices = devicectl?.result?.devices;
  if (!Array.isArray(devices)) return null;
  for (const device of devices) {
    const hw = device?.hardwareProperties ?? {};
    if (hw.deviceType !== "iPad" || device?.connectionProperties?.pairingState !== "paired") continue;
    if (typeof hw.udid !== "string") continue;
    return { udid: hw.udid, name: String(device?.deviceProperties?.name ?? "iPad") };
  }
  return null;
}

function teamIdFromExportOptions() {
  const plist = readFileSync(join(ROOT, "ios", "ExportOptions.plist"), "utf8");
  const match = /<key>teamID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match?.[1] ?? null;
}

function listDevices() {
  const dir = mkdtempSync(join(tmpdir(), "omb-devicectl-"));
  const file = join(dir, "devices.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", "list", "devices", "--json-output", file], { stdio: ["ignore", "ignore", "inherit"] });
    if (result.status !== 0) throw new Error("xcrun devicectl failed; is Xcode installed and its licence accepted?");
    return JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForStatus(port, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(option("--port") ?? 8100);
  const teamId = process.env.OMB_IOS_TEAM_ID || teamIdFromExportOptions();
  if (!teamId) throw new Error("Set OMB_IOS_TEAM_ID (no teamID found in ios/ExportOptions.plist)");
  if (!existsSync(PROJECT)) throw new Error(`WebDriverAgent project missing at ${PROJECT}; run pnpm install`);

  let udid = option("--udid");
  let name = udid ?? "";
  if (!udid) {
    const picked = pickIpad(listDevices());
    if (!picked) throw new Error("No paired iPad found. Plug it in over USB, tap Trust on the iPad, enable Developer Mode, then retry.");
    ({ udid, name } = picked);
  }
  const plan = wdaLaunchPlan({ udid, teamId, project: PROJECT, derivedData: DERIVED, port });
  console.log(`iPad: ${name} (${udid}), team ${teamId}, port ${port}`);

  const built = existsSync(join(DERIVED, "Build", "Products"));
  if (!built || flag("--rebuild")) {
    console.log("Building WebDriverAgentRunner (first build takes a few minutes)...");
    const build = spawnSync("xcodebuild", plan.build, { stdio: "inherit" });
    if (build.status !== 0) throw new Error("xcodebuild build-for-testing failed (see output above; a signing failure usually means the team has no iOS development certificate on this Mac)");
  }

  console.log("Starting the runner on the iPad...");
  const runner = spawn("xcodebuild", plan.test, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...plan.env } });
  const forward = spawn("iproxy", plan.iproxy, { stdio: ["ignore", "ignore", "inherit"] });
  const stop = () => { runner.kill("SIGINT"); forward.kill("SIGINT"); };
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  forward.on("error", () => { console.error("iproxy is missing: brew install libimobiledevice"); stop(); process.exit(1); });

  if (await waitForStatus(port)) {
    console.log(`WebDriverAgent ready at http://127.0.0.1:${port} - leave this running and ask a bot to use the iPad.`);
  } else {
    console.error("WebDriverAgent did not answer within two minutes. Unlock the iPad and check the xcodebuild output above.");
    stop();
    process.exit(1);
  }
  await new Promise((resolve) => runner.on("close", resolve));
  forward.kill("SIGINT");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run scripts/ipad-wda.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the docs**

`docs/ipad-harness.md`:
```markdown
# iPad harness

Bots can see and operate a physical iPad through the bundled `ipad` tools.
The Mac talks to Appium's WebDriverAgent (WDA), an XCTest runner that
OpenMausBot starts on the iPad with a developer script. Design notes:
`docs/superpowers/specs/2026-09-16-ipad-harness-design.md`.

## One-time setup

1. Plug the iPad into this Mac over USB and tap **Trust** on the iPad.
2. On the iPad, turn on **Settings → Privacy & Security → Developer Mode**
   and let it restart.
3. On the Mac: full Xcode with its licence accepted, `brew install
   libimobiledevice` (for `iproxy`), and `pnpm install` in this repo.
4. Signing uses the team in `ios/ExportOptions.plist`; override with
   `OMB_IOS_TEAM_ID=<team>` if needed. The first build asks Xcode to create
   a development certificate and profile automatically.

## Running

```sh
pnpm ipad:wda
```

The first run builds the runner (a few minutes); later runs reuse the build
under `.omb-scratch/wda-derived` (`pnpm ipad:wda -- --rebuild` forces a new
build). Leave the command running: it keeps the runner alive on the iPad and
forwards port 8100 to loopback. Stop it with Ctrl-C.

Then, in OpenMausBot, ask a bot something like "On the iPad, open Notes and
write today's date". Mentioning the iPad selects the `ipad-harness` skill,
which mounts the tools for that turn. Only one thread can drive the iPad at a
time.

## Tools

`status`, `read_screen`, `screenshot`, `open_app`, `tap_text`, `tap`,
`swipe`, `type_text`, `press`. Coordinates are iPad points; screenshots are
downscaled so pixels equal points.

## Limitations

- The iPad must stay paired and on USB while the runner is alive. Sleeping
  the iPad ends the runner; run `pnpm ipad:wda` again.
- The runner is a test bundle and is not part of the packaged app. Without
  it, `status` reports WDA as unreachable and tells the user what to run.
- Secure text fields and protected content are invisible to the tools.
- Pinch and rotate gestures are not available.
- WDA is only accepted on loopback. `OMB_IPAD_WDA_URL` may change the port,
  never the host.
```

- [ ] **Step 7: Full check and commit**

Run: `pnpm exec vitest run && pnpm exec tsc -p tsconfig.server.json --noEmit`
Expected: PASS across the suite.

```bash
git add scripts/ipad-wda.mjs scripts/ipad-wda.test.ts docs/ipad-harness.md package.json pnpm-lock.yaml
git commit -m "feat(ipad): WebDriverAgent developer launcher, pinned dependency, docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Live verification on the iPad

**Files:** none new. This task proves the feature on hardware and fixes whatever the real WDA disagrees with.

- [ ] **Step 1: Pair check**

Run: `xcrun devicectl list devices`
Expected: a row whose Model starts with `iPad` and State `available (paired)`. If absent, stop and ask Omkar to plug in, trust, and enable Developer Mode.

- [ ] **Step 2: Start the runner**

Run: `pnpm ipad:wda` (leave running in a background shell; capture its output to `.omb-scratch/wda.log`).
Expected: `WebDriverAgent ready at http://127.0.0.1:8100`. A signing failure means the team certificate is missing on this Mac; report it verbatim rather than working around it.

- [ ] **Step 3: Exercise the proxy directly**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"press","arguments":{"key":"home"}}}' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"open_app","arguments":{"name":"Notes"}}}' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_screen","arguments":{}}}' '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"screenshot","arguments":{}}}' | node --experimental-strip-types server/drivers/ipad-proxy.ts | cut -c1-300
```
Expected: `available: true` with the real point size; Notes opens on the iPad; `read_screen` lists Notes UI; the screenshot result reports the point size. If any WDA route or field name differs from the table at the top of this plan, fix the proxy and its test fixture together and re-run Task 4's tests.

- [ ] **Step 4: Verify the screenshot scale**

Save the screenshot's base64 to a file and check its width equals the point width from `status` (`sips -g pixelWidth shot.png`).

- [ ] **Step 5: End-to-end chat turn**

Start the dev server per the repo's usual recipe, pick a bot on the Claude engine, and send: "On the iPad, open Notes, create a new note and type Hello from OpenMausBot". Watch the iPad. Expected: the bot calls `status`, `open_app`, `read_screen`, `tap_text`, `type_text`, and the note appears on the device. Capture a screenshot of the chat and one of the iPad for the PR.

- [ ] **Step 6: Record findings**

Append a "Verified on hardware" section to `docs/ipad-harness.md` with the iPad model, iPadOS version, and the date, then commit:
```bash
git add docs/ipad-harness.md server/drivers/ipad-proxy.ts server/drivers/ipad-proxy.test.ts
git commit -m "docs(ipad): hardware verification notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Stop here. Omkar owns pushing and PRs.
