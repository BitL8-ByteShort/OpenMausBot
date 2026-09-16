---
name: ipad-harness
description: "Control, inspect, test, or automate a physical iPad connected to this Mac over USB through WebDriverAgent. Use for explicit iPad, iPadOS, tablet, iPad-app, tapping, typing, swiping, scrolling, screenshot, or iPad-screen requests."
---

# iPad Harness

Use the `ipad` tools for every requested iPad action. Never replace them with
Bash, `xcrun`, `idevice*`, `curl` against WebDriverAgent, a simulator, or any
other automation route.

1. Call `status` before the first action. If WebDriverAgent is not running,
   stop and relay its instruction to the user; do not try to start it.
2. Call `open_app` with the human app name. It opens ANY app installed on the
   iPad, not only Apple's. If the name does not match, call `list_apps` (with a
   query) to find it, then open it by name or bundle id. Never substitute a
   website in Safari for an app the user asked for; if the app is genuinely not
   installed, say so.
3. Call `read_screen` before choosing a target and after every action. Prefer
   `tap_text`; use `screenshot` and point `tap` only when accessibility text
   cannot identify the target. Screenshot pixels equal points.
4. Use `swipe`, `type_text`, and `press` for interaction, verifying each step.
   `type_text` goes to the focused field: tap the field first.

The tools operate the user's real iPad. Navigate and read only what the task
needs. Stop before sending, posting, purchasing, booking, deleting, changing
settings, entering protected information, or accepting an unexpected legal or
security prompt unless the user has explicitly authorized that exact action.

Never enter passwords, payment details, government identifiers, or one-time
codes. Ask the user to complete protected-input steps directly on the iPad.
Secure fields and protected content are invisible to these tools by design.
