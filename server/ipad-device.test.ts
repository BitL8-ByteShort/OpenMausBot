import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createIpadDevice } from "./ipad-device.ts";
import { START_HINT, type FetchLike } from "./drivers/ipad-proxy.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function wdaFetch(opts: { up: boolean }): { fetch: FetchLike; calls: string[] } {
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
  kill(signal: string) {
    this.killed = signal;
    this.emit("close", 0);
    return true;
  }
}
function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as any;
  });
  return { spawn, children };
}

function fakeRes() {
  const res: any = { headers: {} as Record<string, string>, statusCode: 0, body: null as Buffer | string | null };
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
    return res;
  };
  res.end = (body?: Buffer | string) => {
    res.body = body ?? null;
  };
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
    expect(await device.status()).toMatchObject({ running: true, log: ["iPad: iPad (3)", "Building..."] });
    device.stop();
    expect(children[0].killed).toBe("SIGINT");
    expect((await device.status()).running).toBe(false);
  });

  it("refuses to start when the launcher is missing", () => {
    const device = createIpadDevice({ fetch: wdaFetch({ up: false }).fetch, spawn: fakeSpawn().spawn, launcherPath: "/nowhere/ipad-wda.mjs" });
    expect(device.start()).toEqual({ ok: false, status: 501, error: "WebDriverAgent can only be started from a source checkout: run pnpm ipad:wda there" });
  });

  it("serves the four routes", async () => {
    const opts = { up: true };
    const wda = wdaFetch(opts);
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
    // a live WebDriverAgent must not be restarted underneath a working bot
    res = fakeRes();
    await device.handleRoute("POST", "/api/ipad/start", res);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(String(res.body)).error).toContain("already running on the iPad");
    opts.up = false;
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
