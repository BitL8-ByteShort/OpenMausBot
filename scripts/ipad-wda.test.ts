import { describe, expect, it } from "vitest";

import { pickIpad, runnerNotes, wdaLaunchPlan } from "./ipad-wda.mjs";

describe("runnerNotes", () => {
  it("turns xcodebuild's refusals into one actionable line each", () => {
    expect(runnerNotes('Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock iPad (3) to Continue" UserInfo={...}'))
      .toEqual(["The iPad is locked. Unlock it (and set Auto-Lock to Never for a long session), then run this again."]);
    expect(runnerNotes('WebDriverAgent.xcodeproj: error: Device "iPad (3)" isn\'t registered in your developer account.'))
      .toEqual(["The iPad is not registered on this developer team. Add its UDID at developer.apple.com → Devices, then run this again."]);
    expect(runnerNotes("{ platform:iOS, id:X, error:Developer Mode disabled To use iPad (3) for development... }"))
      .toEqual(["Developer Mode is off on the iPad. Turn it on in Settings → Privacy & Security → Developer Mode, restart, then run this again."]);
  });

  it("drops the DVT stack frames and the iproxy retry spam, and never repeats itself", () => {
    const noise = [
      "  0   -[DVTOperation init] (in DVTFoundation)",
      "  15   XcodeBuildMain (in libxcodebuildLoader.dylib)",
      "Error connecting to device: Connection refused",
      '2026-09-16 10:46:56.771 xcodebuild[1:2] [MT] Run Destination Preflight: The destination is not ready.',
      'Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock iPad (3) to Continue"',
      'Error Domain=com.apple.dt.deviceprep Code=-3 "Unlock iPad (3) to Continue"',
    ].join("\n");
    expect(runnerNotes(noise)).toEqual(["The iPad is locked. Unlock it (and set Auto-Lock to Never for a long session), then run this again."]);
  });
});

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
