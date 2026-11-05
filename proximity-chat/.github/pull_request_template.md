## What this changes

<!-- One or two sentences. The "why" matters more than the "what" — the diff shows the what. -->

## Related issues

<!-- e.g. Refs #7, #10. Use bare # references, not auto-close keywords. Issues stay open until the reporter confirms. -->

## Testing

<!--
Describe what you tested manually. If you added or changed tests, mention them.

If this is a UI / WebRTC change, please confirm one of:
- [ ] Real LoL game tested end-to-end (mic captured, peer connected, voice flowed)
- [ ] Smoke-tested without LoL (panel renders, settings open, log writes happen)
- [ ] Pure code change — no runtime behavior affected
-->

## Checklist

- [ ] `npm test` passes
- [ ] `cd server && npm test` passes (if server changes)
- [ ] `npx tauri build` produces a working exe (if client changes)
- [ ] README, CHANGELOG, or relevant `docs/` updated if user-visible behavior or contributor-facing process changed
- [ ] No `as any` introduced outside genuinely untyped boundaries
- [ ] No silent catches added — failures log with enough context to be debuggable
- [ ] No telemetry / fingerprinting / persistent user identifiers added (see `docs/threat-model.md` § "What we don't collect")

## Threat-model implications

<!--
Optional. If this change touches what data flows where, what enemies you can hear, what the server sees, or what the client trusts — please call it out so docs/threat-model.md stays current.
-->
