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

Then, in OpenMausBot, either set the bot's **Works on** to **iPad** in the
Computer panel (the iPad tile is enabled while WebDriverAgent answers or can
be started from this checkout) or leave it on Auto and mention the iPad in
your message. An iPad bot has the tools on every turn and the panel's iPad
tab mirrors the screen. An Auto conversation that started with "on the iPad"
stays on the iPad for its follow-ups; an Auto conversation that never named
the iPad gets no iPad tools. Only one thread can drive the iPad at a time.

The iPad tab also has a **Start WebDriverAgent** button when the app runs
from a source checkout; the packaged app shows the manual instruction. The
phone apps show an iPad bot like any other; changing the destination stays
on the desktop.

## Tools

`status`, `read_screen`, `screenshot`, `open_app`, `tap_text`, `tap`,
`swipe`, `type_text`, `press`. Coordinates are iPad points; screenshots are
downscaled so pixels equal points.

## Verified on hardware

2026-09-16, iPad Air (5th generation, iPad13,16) on iPadOS 26.6.1, Xcode 27.0,
WebDriverAgent 16.12.8, Claude engine with claude-sonnet-5. A chat turn
"On the iPad: open Notes, create a new note, type Hello from OpenMausBot"
called `status`, `open_app`, `read_screen`, `tap_text`, `tap`, `type_text`,
and `read_screen` again, and the note appeared on the device. Screenshots
came back at 1180x820 for the landscape 1180x820-point screen.

Two things found on the device and fixed in the proxy: WDA serves
`/wda/homescreen` outside the session, and creating a second WDA session
deletes the first mid-request, so the proxy shares one in-flight session
creation and runs tool calls strictly in order.

The **Works on → iPad** destination was verified the same day on the same
device. A bot set to iPad answered "Open Notes and tell me the title of the
most recent note" — no iPad wording at all — by calling `status`, `open_app`
and `read_screen`, and named the place first ("Working on the iPad now").
The panel's iPad tab mirrored the screen live throughout, which also proves
the mirror's session-less capture does not disturb the session the turn's
proxy holds. WebDriverAgent was started from the panel's own Start button.

Setup gotchas from the same run: Developer Mode must be on, and the iPad
must be registered on the Supamaus team before automatic signing can build
the runner. Xcode cannot register it with an App Store Connect API key, but
the App Store Connect API itself can (`POST /v1/devices`).

## Limitations

- The iPad must stay paired and on USB while the runner is alive. Sleeping
  the iPad ends the runner; run `pnpm ipad:wda` again.
- The runner is a test bundle and is not part of the packaged app. Without
  it, `status` reports WDA as unreachable and tells the user what to run.
- Secure text fields and protected content are invisible to the tools.
- Pinch and rotate gestures are not available.
- WDA is only accepted on loopback. `OMB_IPAD_WDA_URL` may change the port,
  never the host.
