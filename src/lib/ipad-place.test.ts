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
