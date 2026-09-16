import { describe, expect, it } from "vitest";

import {
  KNOWN_APPS,
  filterApps,
  MAX_ELEMENTS,
  MAX_TEXT,
  START_HINT,
  TOOLS,
  WdaUnreachable,
  createToolRunner,
  createWdaClient,
  elementLines,
  findByText,
  flattenSource,
  resolveApp,
  swipeActions,
  tapActions,
  validatePoint,
  validateText,
  matchInstalled,
  wdaBaseUrl,
  type Downscale,
  type FetchLike,
  type InstalledApp,
  type ListApps,
} from "./ipad-proxy.ts";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const INSTALLED = [
  { name: "YouTube", bundleId: "com.google.ios.youtube" },
  { name: "YouTube Music", bundleId: "com.google.ios.youtubemusic" },
  { name: "Gmail", bundleId: "com.google.Gmail" },
  { name: "Kindle", bundleId: "com.amazon.Lassen" },
  { name: "Clock", bundleId: "com.apple.mobiletimer" },
  { name: "Clock+", bundleId: "com.third.clockplus" },
  { name: "BluetoothUIService", bundleId: "com.apple.BluetoothUIService" },
];

function runnerWith(extraRoutes: Record<string, Route> = {}, downscale: Downscale = async (png) => png, listApps: ListApps = async () => INSTALLED) {
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
    "POST /wda/homescreen": () => ({ value: null }),
    "POST /session/S1/actions": () => ({ value: null }),
    ...extraRoutes,
  });
  const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
  return { run: createToolRunner({ client, downscale, listApps }), calls: wda.calls };
}

describe("TOOLS", () => {
  it("exposes the phone-shaped tools, app discovery included", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["status", "read_screen", "screenshot", "list_apps", "open_app", "tap_text", "tap", "swipe", "type_text", "press"]);
  });
  it("never implies only Apple apps can be opened", () => {
    const openApp = TOOLS.find((t) => t.name === "open_app")!;
    expect(openApp.description).toMatch(/any installed app/i);
    expect(openApp.description).toMatch(/list_apps/);
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
    const run = createToolRunner({ client, downscale: async (png) => png, listApps: async () => INSTALLED });
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

  it("open_app launches an Apple app by name or any raw bundle id", async () => {
    const { run, calls } = runnerWith();
    expect(text(await run("open_app", { name: "Notes" }))).toBe("Opened Notes (com.apple.mobilenotes)");
    expect(calls.find((c) => c.path === "/session/S1/wda/apps/launch")?.body).toEqual({ bundleId: "com.apple.mobilenotes" });
    expect(text(await run("open_app", { name: "org.mozilla.ios.Firefox" }))).toContain("org.mozilla.ios.Firefox");
  });

  it("open_app opens a third-party app the device actually has", async () => {
    const { run, calls } = runnerWith();
    expect(text(await run("open_app", { name: "YouTube" }))).toBe("Opened YouTube (com.google.ios.youtube)");
    expect(calls.filter((c) => c.path === "/session/S1/wda/apps/launch").at(-1)?.body).toEqual({ bundleId: "com.google.ios.youtube" });
    expect(text(await run("open_app", { name: "kindle" }))).toBe("Opened Kindle (com.amazon.Lassen)");
  });

  it("open_app resolves a partial name and names the candidates when ambiguous", async () => {
    const { run } = runnerWith();
    expect(text(await run("open_app", { name: "youtube m" }))).toBe("Opened YouTube Music (com.google.ios.youtubemusic)");
    const ambiguous = await run("open_app", { name: "you" });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain("YouTube Music");
  });

  it("open_app says how to discover apps when nothing matches", async () => {
    const { run } = runnerWith();
    const unknown = await run("open_app", { name: "Fortnite" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/list_apps/);
  });

  it("open_app explains itself when the device list cannot be read", async () => {
    const { run } = runnerWith({}, async (png) => png, async () => { throw new Error("xcrun devicectl failed"); });
    const failed = await run("open_app", { name: "YouTube" });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("xcrun devicectl failed");
    expect(text(await run("open_app", { name: "Notes" }))).toBe("Opened Notes (com.apple.mobilenotes)");
  });

  it("filterApps shows every match, unlike the ranked open_app matcher", () => {
    expect(filterApps("youtube", INSTALLED).map((a) => a.name)).toEqual(["YouTube", "YouTube Music"]);
    expect(filterApps("com.google", INSTALLED).map((a) => a.name)).toEqual(["YouTube", "YouTube Music", "Gmail"]);
    expect(filterApps("", INSTALLED)).toHaveLength(INSTALLED.length);
  });

  it("list_apps lists installed apps and filters by query", async () => {
    const { run } = runnerWith();
    const all = text(await run("list_apps", {}));
    expect(all).toContain("YouTube — com.google.ios.youtube");
    expect(all).toContain("Gmail — com.google.Gmail");
    const filtered = text(await run("list_apps", { query: "youtube" }));
    expect(filtered).toContain("YouTube Music — com.google.ios.youtubemusic");
    expect(filtered).not.toContain("Gmail");
    expect(text(await run("list_apps", { query: "nothingmatches" }))).toContain("No installed app matches");
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
    expect(calls.some((c) => c.path === "/wda/homescreen" && c.method === "POST")).toBe(true);
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
      { type: "Button", label: "Done", name: "", value: "", rect: { x: 10, y: 20, width: 30, height: 40 } },
      { type: "Cell", label: "", name: "row", value: "", rect: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "StaticText", label: "", name: "", value: "Hello", rect: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
  });
  it("drops untitled containers but keeps untitled interactive elements", () => {
    const root = el("Application", {
      children: [
        el("Window", { children: [el("Other", { children: [el("TextField"), el("Other", { label: "titled" })] })] }),
        el("Group", { name: "Notes" }),
      ],
    });
    expect(flattenSource(root).map((e) => `${e.type}:${e.label || e.name}`)).toEqual(["TextField:", "Other:titled", "Group:Notes"]);
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

describe("matchInstalled", () => {
  const apps: InstalledApp[] = [
    { name: "YouTube", bundleId: "com.google.ios.youtube" },
    { name: "YouTube Music", bundleId: "com.google.ios.youtubemusic" },
    { name: "Clock", bundleId: "com.apple.mobiletimer" },
    { name: "Clock+", bundleId: "com.third.clockplus" },
  ];
  it("prefers an exact name over a prefix or substring match", () => {
    expect(matchInstalled("YouTube", apps).map((a) => a.bundleId)).toEqual(["com.google.ios.youtube"]);
    expect(matchInstalled("clock", apps).map((a) => a.bundleId)).toEqual(["com.apple.mobiletimer"]);
  });
  it("falls back to prefix, then substring, and is case- and space-insensitive", () => {
    expect(matchInstalled("youtube mu", apps).map((a) => a.bundleId)).toEqual(["com.google.ios.youtubemusic"]);
    expect(matchInstalled("YouTubeMusic", apps).map((a) => a.bundleId)).toEqual(["com.google.ios.youtubemusic"]);
    expect(matchInstalled("music", apps).map((a) => a.bundleId)).toEqual(["com.google.ios.youtubemusic"]);
  });
  it("matches a bundle id exactly and returns nothing for an unknown name", () => {
    expect(matchInstalled("com.third.clockplus", apps).map((a) => a.name)).toEqual(["Clock+"]);
    expect(matchInstalled("Fortnite", apps)).toEqual([]);
    expect(matchInstalled("", apps)).toEqual([]);
  });
  it("returns every candidate only when they tie at the same rank", () => {
    const ambiguous = [
      { name: "Maps", bundleId: "com.apple.Maps" },
      { name: "Google Maps", bundleId: "com.google.Maps" },
    ];
    // "Maps" wins on exact name, and "map" on prefix — neither is ambiguous
    expect(matchInstalled("maps", ambiguous).map((a) => a.bundleId)).toEqual(["com.apple.Maps"]);
    expect(matchInstalled("map", ambiguous).map((a) => a.bundleId)).toEqual(["com.apple.Maps"]);
    // only a substring that hits both with no better rank is a real tie
    const tied = [
      { name: "Google Maps", bundleId: "com.google.Maps" },
      { name: "Apple Maps", bundleId: "com.apple.Maps" },
    ];
    expect(matchInstalled("maps", tied).map((a) => a.bundleId)).toEqual(["com.google.Maps", "com.apple.Maps"]);
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

  it("shares one in-flight session creation between concurrent calls", async () => {
    let sessions = 0;
    const wda = fakeWda({
      "POST /session": () => ({ value: { sessionId: `S${++sessions}` } }),
      "GET /session/S1/window/size": () => ({ value: { width: 1024, height: 768 } }),
    });
    const client = createWdaClient({ fetch: wda.fetch, baseUrl: "http://127.0.0.1:8100" });
    await Promise.all([client.session("GET", "/window/size"), client.session("GET", "/window/size"), client.session("GET", "/window/size")]);
    expect(sessions).toBe(1);
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
