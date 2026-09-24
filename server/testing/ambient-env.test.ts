import { describe, expect, it } from "vitest";

import { stripAmbientAppEnv } from "./ambient-env.ts";

describe("Vitest environment isolation", () => {
  it("drops app settings while preserving explicit e2e controls and ordinary shell paths", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/fixture-home",
      PATH: "/fixture-bin",
      OMB_DATA_DIR: "/live-data",
      OMB_ROOM_TURN: "1",
      OMB_PORT: "18799",
      OPENMAUSBOT_URL: "https://ambient.invalid",
      OPENMAUSBOT_TOKEN: "ambient-token",
      OMB_UI_E2E: "1",
      OMB_UI_EVIDENCE_DIR: "/fixture-evidence",
      OMB_AGENT_BROWSER_PATH: "/fixture-browser",
      OMB_OPENCODE_E2E_CLI: "/fixture-opencode",
      OMB_RUN_FEEDBACK_SCREENSHOT: "/fixture-screenshot",
    };

    stripAmbientAppEnv(env);

    expect(env).toEqual({
      HOME: "/fixture-home",
      PATH: "/fixture-bin",
      OMB_UI_E2E: "1",
      OMB_UI_EVIDENCE_DIR: "/fixture-evidence",
      OMB_AGENT_BROWSER_PATH: "/fixture-browser",
      OMB_OPENCODE_E2E_CLI: "/fixture-opencode",
      OMB_RUN_FEEDBACK_SCREENSHOT: "/fixture-screenshot",
    });
  });
});
