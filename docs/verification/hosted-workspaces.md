# Hosted workspace sign-in and revocation

This repository ships the workspace-side protocol adapter, not a hosted
administration console. The adapter is optional, belongs to the licensed
`enterprise/` layer, and does not add dependencies to the desktop or ordinary
self-hosted server. An independently deployed identity service owns its own
accounts, invitations and provider gateway.

## Configuration and protocol

An operator configures the workspace with an HTTPS `OMB_ADMIN_URL` origin,
its `OMB_ADMIN_WORKSPACE` slug, its exact HTTPS `OMB_PUBLIC_URL`, and an
active `admin` entitlement. Partial or invalid hosted configuration denies
remote access; it never enables legacy email or QR sign-in as a fallback.
Credential-free, unproxied loopback owner access remains available for recovery.

1. The workspace's `/api/auth/hosted/start` creates bounded, expiring state
   and a secure host-only handoff cookie. It redirects to the identity
   service's `/connect` with workspace, state and a SHA-256 PKCE challenge.
2. The service returns a one-use code to `/api/auth/hosted/callback`.
   State and cookie must match. The workspace consumes local state before
   awaiting `POST /api/handoff/consume` with workspace, code and verifier.
3. A successful response contains email, role (`admin` or `member`) and a
   high-entropy workspace-bound grant. The adapter issues a normal scoped
   workspace session. By default the local email allow-list also narrows
   its access.
4. Every authenticated remote request checks the grant at
   `POST /api/handoff/check`. Membership removal or loss of an issued scope
   revokes the session. Promotion does not widen an existing credential.
An unavailable service denies access and closes streams without treating
   an outage as permanent membership removal.

An operator may explicitly set `OMB_ADMIN_MEMBERSHIP=portal` when the identity
service is the sole membership authority. This requires the complete valid
hosted configuration above. Only sessions internally marked after a successful
portal grant exchange may skip the local allow-list; ordinary email sessions,
pairing credentials and a `portal:` user ID alone never gain that exemption.
All remote grant checks and stream revocation still apply. Unset the mode (or
set it to `local`) to restore local narrowing, including for saved sessions.
Other mode values fail closed. This opt-in avoids rewriting tenant allow-lists
or restarting a tenant for every accepted invitation.

Backchannel requests go only to the configured HTTPS origin, omit browser
cookies, reject redirects, and have a five-second deadline. A ten-second
revalidation cadence closes quiet event/browser streams after access ends;
the combined bound is fifteen seconds. Invalid or revoked credentials may
not fall back to the local owner merely by using a loopback address.

The public fleet supports this configuration plus workspace-scoped managed
Anthropic/OpenRouter credentials. Never seed a hosted workspace with a
provider gateway's master key. These runtime seams do not require a particular
console repository, orchestration platform, or cloud provider.

## Isolated verification

Read [the verification entry point](README.md) first. Run only disposable
fixtures; do not point these tests at an existing app, workspace or identity
service.

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run server/hosted-access.test.ts enterprise/server/workspace-access.test.ts server/email-signin.test.ts server/sessions.test.ts server/request-auth.test.ts server/enterprise.test.ts server/browser-live.test.ts server/fleet.test.ts server/fleet-cli.test.ts server/fleet-agent.test.ts server/fleet-cli-filesystem.test.ts
pnpm test:packaged-server
```

The full-server fixture launches an owned server with a disposable home and
an injected fake HTTPS backchannel. It verifies hosted navigation, disabled
legacy credentials, local recovery access, sign-in, outage, demotion,
reauthentication and quiet event-stream closure. The bridge tests use real
HTTP, cookies and sessions to check PKCE mismatch, expiry, replay, host
binding and live permission checks. Fleet fixtures use disposable sockets,
recording executors and bounded child processes for hostile file cases.

These checks do not deploy a console, send real mail, issue TLS certificates,
call a paid provider or prove Linux tenant isolation. Real root transitions,
service/fence ordering, proxy boundaries, reboot recovery and backup restore
still require a separately authorized disposable Linux deployment using the
[fleet recipe](fleet.md).

## Observed local result — 2026-09-13

The commands above passed after extracting the runtime changes onto public
main `c610e6cd`: 218 targeted tests, typecheck, lint, all twelve packaged proxy
paths and the packaged MCP round trip. The production UI build also passed.
The full-server fixture additionally proved explicit portal membership with
an empty local allow-list, including outage, demotion and quiet-stream
revocation. All identities, sessions, fleet actions and backchannels were
disposable or synthetic; no production deployment was exercised.
