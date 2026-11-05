# Security Policy

## Supported Versions

Only the latest release receives security updates. Older versions can be upgraded by enabling auto-update in Settings, or by downloading the newest `lolproxchat.exe` from [Releases](https://github.com/danthi123/LoLProxChat/releases/latest).

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use GitHub's private security advisory flow instead:

1. Go to the [Security tab](https://github.com/danthi123/LoLProxChat/security) on the repo.
2. Click **Report a vulnerability**.
3. Fill in the form. GitHub keeps the report private to the maintainer; the broader community sees nothing until a fix is shipped and you choose to publish.

If you can't use that flow for any reason, open a regular GitHub issue titled `Security: please contact me` (no details) and the maintainer will reach out to set up a private channel.

## What's in scope

- The client application (`lolproxchat.exe`), including the Rust backend, the WebView2 frontend code, and the signaling/WebRTC integration.
- The signaling server (`server/`) at `proxchat.dant123.com` and its `/turn-credentials`, `/compute-volumes`, `/health`, `/ws` endpoints.
- The position-handling and proximity design — coordinates sent over TLS, computed into volumes server-side so peers never receive raw positions.

## What's out of scope

- Cloudflare Realtime TURN — report directly to Cloudflare.
- WebView2 / Microsoft Edge — report directly to Microsoft.
- The Tauri runtime — report to the [Tauri security team](https://github.com/tauri-apps/tauri/security).
- Social-engineering attacks (typosquatted releases, mirror reposts) — already partially mitigated by the SHA-256 hash in every release body. See the [user guide](docs/user-guide.md) for the verification flow.

## Threat model

For the full breakdown of what the design protects against, what it doesn't, and the rationale behind each call, see [`docs/threat-model.md`](docs/threat-model.md). Two parts:

- **Part 1** — cheat / information-leak threats (the volume side channel, self-reported-position trust, server-side volume math).
- **Part 2** — threats to users (public IP exposure, server-operator trust, code-signing absence, etc.).

That document also lists what data is and isn't collected (the short version: no analytics, no telemetry, no fingerprinting, no persistent user IDs).

## Response expectations

Solo-maintained personal project. Best effort, no formal SLA. Realistic expectations:

- Initial acknowledgement: within a few days.
- Triage + fix timeline: depends on severity and complexity. Critical issues affecting active users get priority.
- Coordinated disclosure: happy to credit reporters in the changelog and release notes if you'd like.
