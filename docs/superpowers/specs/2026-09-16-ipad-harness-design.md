# iPad harness: computer use on a physical iPad through WebDriverAgent

Date: 2026-09-16. Status: approved design, awaiting implementation plan.

## Goal

Let an OpenMausBot bot see and operate a physical iPad the way it already
operates an Android phone: read the screen, tap, swipe, type, open apps, and
take screenshots, from an ordinary chat turn. The first use is a demo where a
bot on the Mac drives an iPad sitting on the desk. The tools are real product
code; only the WebDriverAgent launcher stays a developer script.

## Why WebDriverAgent

iPadOS gives an app no way to tap, type, or capture outside itself. The two
known workarounds are a USB HID dongle plus a ReplayKit broadcast (the
`jamiepinheiro/ipad_computer_use` approach) or Apple's XCTest UI automation,
which is what Appium's WebDriverAgent (WDA) packages. WDA runs as an XCTest
runner on a Developer-Mode iPad and exposes an HTTP API for system-wide real
touches, key input, the accessibility tree, and screenshots. No hardware, no
pointer calibration, multi-touch gestures work, and the Mac already has Xcode
and `iproxy`. The trade-off is that the runner must be built and started from
Xcode tooling and cannot ship in an App Store build, so the launcher is a dev
script and the iPad must stay attached to the Mac over USB.

## Architecture

```
chat turn ──selects skill──▶ index.ts mounts integrations.ipad
                                   │ stdio MCP
                                   ▼
                     server/drivers/ipad-proxy.ts   (Mac, packaged)
                                   │ HTTP, loopback only
                                   ▼
                     iproxy 8100 → USB → WebDriverAgentRunner   (iPad, dev script)
                                   │ XCTest
                                   ▼
                                 iPadOS
```

- **ipad-proxy.ts** is a first-party stdio MCP server, structurally a sibling
  of `drivers/phone-proxy.ts`: no imports from the rest of the server, one
  `TOOLS` table, one `callTool`, the same hand-rolled JSON-RPC loop. It talks
  to WDA at `http://127.0.0.1:8100` and refuses any override whose host is not
  loopback (`OMB_IPAD_WDA_URL` may only change the port). USB through
  `iproxy` is the sole transport, mirroring the Android driver's USB-only rule.
- **scripts/ipad-wda.mjs** is the developer launcher. It resolves the iPad UDID
  with `xcrun devicectl list devices`, builds `WebDriverAgentRunner` from the
  `appium-webdriveragent` npm package (pinned devDependency) with
  `xcodebuild build-for-testing`, runs `test-without-building` against the
  device signed with the team in `OMB_IOS_TEAM_ID` (default: the `teamID` in
  `ios/ExportOptions.plist`), starts `iproxy 8100 8100 -u <UDID>`, and waits
  until `GET /status` answers. It is not part of the packaged app.
- **skills/ipad-harness** is a bundled skill with `manifest.json` trigger terms
  (`ipad`, `ipados`, `tablet`, `on the ipad`, `ipad app`, `ipad screen`) and
  `requiredCapabilities: ["ipadMcp"]`. Its SKILL.md follows phone-harness:
  `status` first, `open_app` by name, `read_screen` before and after every
  action, prefer `tap_text`, and the same stop-before-purchase and
  never-enter-secrets rules.

## Tool surface (MCP server name `ipad`)

All coordinates are iPad points, not pixels.

| Tool | Behaviour |
| --- | --- |
| `status` | Reports whether WDA answers on loopback, the device name, iPadOS version, screen size in points and scale factor. When unreachable, returns the exact developer instruction (`pnpm ipad:wda`) instead of an error. |
| `read_screen` | Fetches `/source?format=json`, flattens to visible, non-zero-size elements with `type`, `label`, `name`, `value`, and `rect` in points, capped at 300 elements. Output is one line per element, like the Android driver. |
| `screenshot` | Fetches `/screenshot`, downscales the PNG by the device scale factor with macOS `sips` so pixels equal points, and returns a PNG image plus a text line stating the size. |
| `open_app` | Launches by bundle id through `/wda/apps/launch`. Accepts a human name via a built-in map of Apple apps (Safari, Notes, Settings, Mail, Messages, Photos, Files, Calendar, Maps, Music, Reminders, App Store, Freeform, Clock, Camera, Books, Podcasts, Shortcuts) or any raw bundle id containing a dot. Unknown names fail with a hint to tap the icon on the home screen with `tap_text`. |
| `tap_text` | Case-insensitive match against `label`, `name`, or `value` of `read_screen` elements, optional `exact` and `index`, then a real touch at the rect centre. |
| `tap` | Touch at `x`, `y` points via W3C `/actions` pointer-touch sequence. Bounds-checked against the screen size. |
| `swipe` | `up`, `down`, `left`, `right` as a W3C touch drag across the middle 50% of the screen, 300 ms. |
| `type_text` | `POST /wda/keys` into the focused field; up to 512 characters of printable text. |
| `press` | `home` (`/wda/homescreen`), `enter` (`\n`), `delete` (`\b`), `tab`, `space`. |

### WDA session handling

WDA needs a session id for element and action routes. The proxy creates one
lazily with empty capabilities, caches it for the process lifetime, and on an
`invalid session id` response creates a new one and retries the call exactly
once. `/status`, `/screenshot`, and `/source` are called without a session.

## Wiring into the server

- `server/proxy-paths.ts`: `ipad: resolveProxy("drivers/ipad-proxy")` so the
  packaged-layout smoke test asserts the file ships.
- `scripts/bundle-server.mjs`: add `drivers/ipad-proxy.ts` to `ENTRY_POINTS`.
- `server/mcp-registry.ts`: reserve the name `ipad`.
- `server/contracts.ts`: `ipadMcp?: boolean` beside `phoneMcp`, with the same
  comment about never offering a knob the driver cannot turn.
- `server/drivers/{claude,codex,pi}.ts`: declare `ipadMcp: true` wherever
  `phoneMcp: true` is declared, and mount `turn.integrations.ipad` exactly as
  `turn.integrations.phone` is mounted (Claude also allows `mcp__ipad`).
- `server/harness/registry.ts`: expose `ipadMcp` beside `phoneMcp`.
- `server/index.ts`: an `ipadIntegration()` beside `phoneIntegration()` that
  passes through `OMB_IPAD_WDA_URL`; both skill-selection sites pass
  `"ipadMcp"` when the driver has it and mount the integration after claiming
  the `computer:ipad` turn resource, so two threads cannot drive the iPad at
  once.
- `package.json`: `appium-webdriveragent` as a pinned devDependency and an
  `ipad:wda` script pointing at the launcher.
- `docs/ipad-harness.md`: pairing, Developer Mode, first build with
  `-allowProvisioningUpdates`, the demo flow, and the limitations below.

## Error handling

- Every WDA call has a timeout: 15 s by default, 30 s for `screenshot` and
  `read_screen`. A timeout or connection refusal returns an `isError` tool
  result whose text is the developer instruction, never a hang.
- `open_app` ambiguity and unknown keys are argument errors, not crashes.
- `tap` rejects coordinates outside the screen; `type_text` rejects empty,
  over-long, or control-character input.
- The `sips` downscale failing falls back to the original PNG with a note.

## Testing

- `server/drivers/ipad-proxy.test.ts` with an injected `fetch`: source
  flattening (visibility, cap, rect conversion), W3C action builders for tap
  and swipe, app-name lookup including raw bundle ids, argument validation,
  and the invalid-session retry happening once.
- `server/skill-library.test.ts`: "open notes on the ipad" selects
  ipad-harness and not phone-harness; "on my phone" does the reverse.
- Existing `proxy-paths.test.ts` and `scripts/smoke-packaged-server.mjs` cover
  the new spawned proxy without changes.
- Manual: `pnpm ipad:wda`, then a chat turn on the Claude engine such as
  "On the iPad, open Notes and write today's date", verified on the device.

## Limitations, stated up front

- The iPad must be in Developer Mode, paired with this Mac, and connected over
  USB while the runner is alive. Sleeping the iPad ends the runner.
- WDA builds are signed with the Supamaus paid team, so the runner stays valid
  for a year; a Personal Team would need a rebuild every seven days.
- Protected content and secure text fields are invisible to the accessibility
  tree and to screenshots, as on any XCTest run.
- Not App Store shippable: the runner is a test bundle. The `ipad` tools in
  the packaged Mac app simply report WDA as unreachable without it.
- Pinch and rotate are out of scope for this version.
