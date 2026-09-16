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
