import { describe, expect, it } from "vitest";

import { pickIpad, wdaLaunchPlan } from "./ipad-wda.mjs";

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
