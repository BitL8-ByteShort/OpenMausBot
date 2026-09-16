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
