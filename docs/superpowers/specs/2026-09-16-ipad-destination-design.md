# iPad as a computer destination

Date: 2026-09-16. Status: approved design, awaiting implementation plan.
Builds on `2026-09-16-ipad-harness-design.md` (the `ipad` proxy, skill and
launcher), which stays as built.

## Goal

Let a bot be set to work on the iPad the way it can be set to the built-in
browser, the Local VM or the cloud computer: chosen once per bot in the
Computer panel, tools mounted on every turn without trigger words, a live
mirror of the iPad in the panel, and the place named in the composer chip.
The Android phone's per-message trigger path is kept for bots on Auto.

## Not in scope

- Tapping or typing on the mirror. The bot drives; the person watches.
- Picking the iPad from the iOS or Android companion apps. They only render
  the new value correctly.
- Shipping WebDriverAgent in the packaged app. Auto-start is a dev-tree
  convenience; the packaged app shows the manual instruction.

## Surface model

- `server/surface.ts`: `Surface` gains `"ipad"`; `Destination` follows.
  `resolveSurface` passes `ipad` through exactly like `vm` and `local`.
  `surfaceLabel("ipad")` is `"the iPad"`.
- `server/store.ts`: the bot record's `computer` union gains `"ipad"`;
  every parser/validator that lists the allowed values accepts it.
- `server/bot-overview.ts`: `computerReach("ipad")` returns
  `"Computer preference: the iPad."`.
- `server/system-prompt.ts`: `ComputerPromptKind` gains `"ipad"` with this
  paragraph: " You can act on the user's iPad through the ipad tools. Call
  status first, read_screen before choosing a target and after every action,
  prefer tap_text, and use screenshot plus point tap only when accessibility
  text cannot identify the target. Type only into a field you have tapped.
  Never enter passwords, payment details, or one-time codes; ask the user to
  do those on the iPad." followed by the shared sign-in policy like the
  other kinds.
- `server/index.ts` dispatch: when the turn's surface plan resolves to
  `ipad`, claim the `computer:ipad` turn resource (error text "another
  thread is using the iPad — wait for it to finish"), mount
  `integrations.ipad = ipadIntegration()`, and set the computer kind so the
  prompt paragraph and `mountedComputer` are `ipad`. The trigger-term mount
  added by the harness spec also reports `mountedComputer = "ipad"`, so an
  Auto thread whose first turn said "on the iPad" records `surface: "ipad"`
  as its pin and later turns stay on the device without the word.
- The computer-selection preview, the room plan and the routine `runOn`
  paths treat `ipad` as a plain local surface: never forced to the cloud,
  never a remote provider.

## Harness iPad service

New `server/ipad-device.ts`, imported by `index.ts`:

- Reuses `createWdaClient` and `wdaBaseUrl` from
  `server/drivers/ipad-proxy.ts`. That module is safe to import: its stdio
  loop runs only when it is the entry script.
- Uses only session-less WDA routes so it never disturbs the session a
  turn's proxy holds: `GET /status` for reachability and `GET /screenshot`
  for frames.
- `status()` returns `{ reachable, device, os, startable, running, log }`
  where `startable` is true when the launcher script exists at
  `<SERVER_ROOT>/../scripts/ipad-wda.mjs` (dev tree), `running` reflects a
  launcher child this process spawned, and `log` is the last 20 lines of
  that child's output.
- `frame()` returns the raw PNG from WDA, cached for one second so several
  viewers share one capture.
- `start()` spawns `process.execPath <script>` with the server's cwd set to
  the checkout root, keeps the child, and refuses a second start while one
  runs. `stop()` sends SIGINT. The child dies with the server.
- Routes, all loopback/authenticated like the other `/api` routes:
  `GET /api/ipad/status`, `GET /api/ipad/frame` (image/png, 503 when
  unreachable), `POST /api/ipad/start` (409 when running, 501 when not
  startable), `POST /api/ipad/stop`.
- `OMB_IPAD_WDA_URL` applies here too, with the same loopback-only rule.

## Desktop UI

- `src/components/ComputerPanel.tsx`: the destination grid gains an iPad
  tile (Tablet icon). Enabled when the status is reachable or startable;
  otherwise disabled with the reason text. Choosing it patches the bot's
  `computer` to `ipad` like the other tiles.
- A new panel view `"ipad"` renders `IpadDevicePanel`: the mirror as an
  `<img>` refreshed from `/api/ipad/frame` every two seconds while the panel
  is visible (paused when hidden, like the Android mirror), a status line
  (connected with device and OS, or unreachable with the instruction), a
  Start button when startable and not running, a Stop button when running,
  and the last log lines when a start failed.
- Composer chip and pin labels: `ipad` renders as "iPad".
- New English locale keys under `computer.ipad.*`; other locales fall back.

## Phone apps

- iOS: wherever a bot's `computer` or a thread's pinned surface is turned
  into a label (overview, chips, computer view header), add the `ipad`
  case with the label "iPad". No picker.
- Android: same mapping in the equivalent label helpers. No picker.

## Error handling

- Unreachable WDA never blocks the panel: the tile is enabled if startable,
  the mirror shows the instruction, and a turn on an iPad bot still mounts
  the tools (their `status` explains the problem to the bot, which relays it).
- A launcher start that exits non-zero leaves `running: false` and the log
  in status, which the panel shows.
- Frame fetches that fail show the last good frame dimmed with the status
  line; they do not throw in the renderer.

## Testing

- `server/surface.test.ts`: `ipad` resolves, labels, pins and is not
  disturbed by browser settings.
- `server/bot-overview.test.ts` and `server/system-prompt.test.ts`: the new
  strings.
- `server/ipad-device.test.ts`: status/frame/start/stop with an injected
  fetch and an injected spawn; the one-second frame cache; startable false
  when the script is absent.
- Route tests in the existing server test harness for the four routes.
- `src/components/ComputerPanel` tests: the tile's enabled/disabled reasons
  from status.
- Manual on the iPad: set a bot to iPad, watch the mirror while it works,
  and confirm a follow-up without the word iPad still acts on the device.
