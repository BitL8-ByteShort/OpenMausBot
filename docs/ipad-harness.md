# iPad harness

Bots can see and operate a physical iPad through the bundled `ipad` tools.
The Mac talks to Appium's WebDriverAgent (WDA), an XCTest runner that
OpenMausBot starts on the iPad with a developer script. Design notes:
`docs/superpowers/specs/2026-09-16-ipad-harness-design.md`.

## One-time setup

1. Plug the iPad into this Mac over USB and tap **Trust** on the iPad.
2. On the iPad, turn on **Settings → Privacy & Security → Developer Mode**
   and let it restart.
3. On the Mac: full Xcode with its licence accepted, `brew install
   libimobiledevice` (for `iproxy`), and `pnpm install` in this repo.
4. Signing uses the team in `ios/ExportOptions.plist`; override with
   `OMB_IOS_TEAM_ID=<team>` if needed. The first build asks Xcode to create
   a development certificate and profile automatically.

## Running

```sh
pnpm ipad:wda
```

The first run builds the runner (a few minutes); later runs reuse the build
under `.omb-scratch/wda-derived` (`pnpm ipad:wda -- --rebuild` forces a new
build). Leave the command running: it keeps the runner alive on the iPad and
forwards port 8100 to loopback. Stop it with Ctrl-C.

Then, in OpenMausBot, ask a bot something like "On the iPad, open Notes and
write today's date". Mentioning the iPad selects the `ipad-harness` skill,
which mounts the tools for that turn. Only one thread can drive the iPad at a
time.

## Tools

`status`, `read_screen`, `screenshot`, `open_app`, `tap_text`, `tap`,
`swipe`, `type_text`, `press`. Coordinates are iPad points; screenshots are
downscaled so pixels equal points.

## Limitations

- The iPad must stay paired and on USB while the runner is alive. Sleeping
  the iPad ends the runner; run `pnpm ipad:wda` again.
- The runner is a test bundle and is not part of the packaged app. Without
  it, `status` reports WDA as unreachable and tells the user what to run.
- Secure text fields and protected content are invisible to the tools.
- Pinch and rotate gestures are not available.
- WDA is only accepted on loopback. `OMB_IPAD_WDA_URL` may change the port,
  never the host.
