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
    for (const raw of chunk.toString("utf8").split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      // iproxy prints "Connection refused" once a second until the runner
      // answers; a repeat adds nothing and would push the useful lines out.
      if (log.at(-1) === line) continue;
      log.push(line);
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
    proc.on("error", (error) => {
      pushLog(Buffer.from(`launcher error: ${error.message}\n`));
      child = null;
    });
    proc.on("close", (code) => {
      pushLog(Buffer.from(`launcher exited with ${code ?? "signal"}\n`));
      child = null;
    });
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
      // A second runner fights the live one for port 8100 and restarts the
      // XCTest session under a working bot; only start when nothing answers.
      if ((await status()).reachable) {
        json(res, 409, { error: "WebDriverAgent is already running on the iPad" });
        return true;
      }
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
