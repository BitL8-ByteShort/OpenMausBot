// Developer launcher for the iPad harness. Builds Appium's WebDriverAgent
// runner from the pinned npm package, runs it on the USB-attached iPad, and
// forwards its port to loopback with iproxy so server/drivers/ipad-proxy.ts
// can reach it at http://127.0.0.1:8100. Not shipped in the packaged app.
//
//   pnpm ipad:wda                 # build once (cached in .omb-scratch), run
//   pnpm ipad:wda -- --rebuild    # force a rebuild
//   pnpm ipad:wda -- --udid X     # pick a device explicitly
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = join(ROOT, "node_modules", "appium-webdriveragent", "WebDriverAgent.xcodeproj");
const DERIVED = join(ROOT, ".omb-scratch", "wda-derived");
const RUNNER_ID = "com.openmausbot.WebDriverAgentRunner";

export function wdaLaunchPlan({ udid, teamId, project, derivedData, port }) {
  const common = [
    "-project", project, "-scheme", "WebDriverAgentRunner",
    "-destination", `id=${udid}`, "-derivedDataPath", derivedData,
    `DEVELOPMENT_TEAM=${teamId}`, "CODE_SIGN_STYLE=Automatic", `PRODUCT_BUNDLE_IDENTIFIER=${RUNNER_ID}`,
  ];
  return {
    build: ["build-for-testing", ...common, "-allowProvisioningUpdates"],
    test: ["test-without-building", ...common],
    // WDA's runner scheme forwards USE_PORT from xcodebuild's environment.
    env: { USE_PORT: String(port) },
    iproxy: [String(port), String(port), "-u", udid],
  };
}

/** First paired iPad in `xcrun devicectl list devices --json-output` output. */
export function pickIpad(devicectl) {
  const devices = devicectl?.result?.devices;
  if (!Array.isArray(devices)) return null;
  for (const device of devices) {
    const hw = device?.hardwareProperties ?? {};
    if (hw.deviceType !== "iPad" || device?.connectionProperties?.pairingState !== "paired") continue;
    if (typeof hw.udid !== "string") continue;
    return { udid: hw.udid, name: String(device?.deviceProperties?.name ?? "iPad") };
  }
  return null;
}

/** xcodebuild answers a refusal with one useful sentence and several hundred
 * lines of DVT stack frames. Print the sentence; drop the frames. */
export function runnerNotes(text) {
  const notes = [];
  for (const line of text.split("\n")) {
    const locked = /Unlock ([^"]+) to Continue|device is locked/.exec(line);
    if (locked) {
      notes.push("The iPad is locked. Unlock it (and set Auto-Lock to Never for a long session), then run this again.");
      continue;
    }
    if (/isn't registered in your developer account|not registered to your team/.test(line)) {
      notes.push("The iPad is not registered on this developer team. Add its UDID at developer.apple.com → Devices, then run this again.");
      continue;
    }
    if (/Developer Mode disabled/.test(line)) {
      notes.push("Developer Mode is off on the iPad. Turn it on in Settings → Privacy & Security → Developer Mode, restart, then run this again.");
      continue;
    }
    if (/^(\*\* TEST|Testing failed|\s+error:)/.test(line) || /^[^\s].*\berror:/.test(line)) notes.push(line.trim());
  }
  return [...new Set(notes)];
}

function report(text) {
  for (const note of runnerNotes(text)) console.error(note);
}

function teamIdFromExportOptions() {
  const plist = readFileSync(join(ROOT, "ios", "ExportOptions.plist"), "utf8");
  const match = /<key>teamID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match?.[1] ?? null;
}

function listDevices() {
  const dir = mkdtempSync(join(tmpdir(), "omb-devicectl-"));
  const file = join(dir, "devices.json");
  try {
    const result = spawnSync("xcrun", ["devicectl", "list", "devices", "--json-output", file], { stdio: ["ignore", "ignore", "inherit"] });
    if (result.status !== 0) throw new Error("xcrun devicectl failed; is Xcode installed and its licence accepted?");
    return JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForStatus(port, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(option("--port") ?? 8100);
  const teamId = process.env.OMB_IOS_TEAM_ID || teamIdFromExportOptions();
  if (!teamId) throw new Error("Set OMB_IOS_TEAM_ID (no teamID found in ios/ExportOptions.plist)");
  if (!existsSync(PROJECT)) throw new Error(`WebDriverAgent project missing at ${PROJECT}; run pnpm install`);

  let udid = option("--udid");
  let name = udid ?? "";
  if (!udid) {
    const picked = pickIpad(listDevices());
    if (!picked) throw new Error("No paired iPad found. Plug it in over USB, tap Trust on the iPad, enable Developer Mode, then retry.");
    ({ udid, name } = picked);
  }
  const plan = wdaLaunchPlan({ udid, teamId, project: PROJECT, derivedData: DERIVED, port });
  console.log(`iPad: ${name} (${udid}), team ${teamId}, port ${port}`);

  const built = existsSync(join(DERIVED, "Build", "Products"));
  if (!built || flag("--rebuild")) {
    console.log("Building WebDriverAgentRunner (first build takes a few minutes)...");
    const build = spawnSync("xcodebuild", plan.build, { stdio: "inherit" });
    if (build.status !== 0) throw new Error("xcodebuild build-for-testing failed (see output above; a signing failure usually means the team has no iOS development certificate on this Mac)");
  }

  console.log("Starting the runner on the iPad...");
  const runner = spawn("xcodebuild", plan.test, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...plan.env } });
  for (const stream of [runner.stdout, runner.stderr]) stream.on("data", (chunk) => report(chunk.toString("utf8")));
  // iproxy retries once a second until the runner answers; that spam would
  // bury the one line that matters (a locked iPad, a signing refusal).
  const forward = spawn("iproxy", plan.iproxy, { stdio: ["ignore", "ignore", "pipe"] });
  forward.stderr.on("data", () => {});
  const stop = () => { runner.kill("SIGINT"); forward.kill("SIGINT"); };
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  forward.on("error", () => { console.error("iproxy is missing: brew install libimobiledevice"); stop(); process.exit(1); });

  if (await waitForStatus(port)) {
    console.log(`WebDriverAgent ready at http://127.0.0.1:${port} - leave this running and ask a bot to use the iPad.`);
  } else {
    console.error("WebDriverAgent did not answer within two minutes. Unlock the iPad and check the xcodebuild output above.");
    stop();
    process.exit(1);
  }
  await new Promise((resolve) => runner.on("close", resolve));
  forward.kill("SIGINT");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
