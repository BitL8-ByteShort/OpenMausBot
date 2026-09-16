import { describe, expect, it } from "vitest";

import {
  KNOWN_APPS,
  MAX_ELEMENTS,
  MAX_TEXT,
  START_HINT,
  WdaUnreachable,
  createWdaClient,
  elementLines,
  findByText,
  flattenSource,
  resolveApp,
  swipeActions,
  tapActions,
  validatePoint,
  validateText,
  wdaBaseUrl,
  type FetchLike,
} from "./ipad-proxy.ts";

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
