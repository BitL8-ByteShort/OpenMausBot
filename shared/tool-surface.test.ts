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
