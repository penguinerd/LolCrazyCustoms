# Refactor: Server-Side Position Storage

Branch: `refactor/server-side-positions`
Status: PLANNING → IMPLEMENTATION → ready for production deploy
Author: paired with Claude
Date: 2026-06-02

## Motivation

The current data flow for proximity-volume computation:

```
Client A (encrypts position) → WebRTC data channel → Client B (relay, can't decrypt)
                                                      └→ POST /compute-volumes → Server
                                                          (decrypts blob, computes distances)
```

This is a Supabase-era artifact. The current Node server doesn't need the broadcast-fanout pattern the Supabase Realtime channels enforced. The encryption exists specifically because peers acted as a transport for blobs only the server could read — which is roundabout.

Costs of the current design:

- **Clock-skew sensitivity** — encrypted blobs carry the client's `payload.t`; if the client clock drifts beyond `BLOB_MAX_AGE_MS`, every blob is rejected. Source of issue #7's asymmetric-voice symptom.
- **Two-hop latency** — Client A's position needs to traverse A → P2P data channel → Client B → HTTPS → Server before any peer can hear A. Adds ~100-300 ms of staleness.
- **Bandwidth waste** — every position blob is sent N times (once per peer) over WebRTC data channels, then duplicated again when each peer forwards it in their `/compute-volumes` request.
- **Code surface** — encryption module (~80 LOC server), DataChannelService (~100 LOC client), blob aging logic, related tests. All maintenance burden.
- **Debug complexity** — issues like #7 required reading dual-sided logs + server logs + cross-referencing timestamps. A single-hop design eliminates several failure modes.

## Target design

```
Client A → WSS message {type:'position', x, y} → Server stores in room state
Client A → POST /compute-volumes {myPosition, roomId, name} → Server reads room
                                                              state, computes
                                                              pairwise distances,
                                                              returns peerVolumes
```

Server holds per-room positions in memory while the room is active. Clients no longer relay anything for each other.

## Design choices

### Why HTTP for the volume request, not WSS?

Could fold `/compute-volumes` into WSS messages too (`{type: 'request_volumes'}` → server responds with `{type: 'volumes', peerVolumes}`). Considered and deferred:

- Pro: single connection, lower per-request overhead.
- Con: bigger client refactor — currently `volumeClient.computeVolumes` is a synchronous `await`. Moving to message-based would require restructuring `positionTick`.
- Decision: keep HTTP for now, leave WSS-everywhere as a future possible cleanup.

### Why hold positions in memory rather than persist?

- Rooms are ephemeral (entire room dissolves when last client leaves).
- Restart-resilience: server restarts today are already invisible to clients via reconnect logic. With server-side positions, a restart wipes positions and clients re-submit on next tick — ~100 ms of dead audio, same as a network blip.
- No need for a DB or external store. Pure in-process.

### Back-compat strategy

Server accepts BOTH old shape and new shape on `/compute-volumes`:

- Old shape: `{myPosition, peers: {name: encryptedBlob}}` → old code path, decrypts blobs.
- New shape: `{myPosition, roomId, name}` → new code path, reads room state.

Client behavior:

- Old clients: keep sending encrypted blobs over data channels. Server old-path returns volumes as before. Continue to work.
- New clients: stop using data channels for positions, send via WSS, request volumes with new body shape.

Mixed-version sessions: old + new clients in the same room would NOT compute volumes for each other. Old client posts `peers: {NewClient: <no blob, never received>}` → no blob to decrypt → 0. New client requests volumes from room state → old client never sent WSS `position` → not in room state → 0. **Both directions silently fail for the cross-version pair.** Same-version pairs continue to work.

This is acceptable because:
- Auto-update brings most users to the new version within hours.
- The mixed-version window is small.
- We can ship a short release-notes warning ("voice may not work with peers on v0.1.33 or earlier — make sure all of your group updates").

Post-deprecation: drop the old code path after 1-2 release cycles. Removes encryption + DataChannelService entirely.

### What stays encrypted

Voice. WebRTC DTLS-SRTP. Unchanged.

The only thing that becomes unencrypted is the position payload between client and server, which is already on HTTPS/WSS. So in transit, positions remain protected by transport-layer encryption. The change is purely about the application-layer encryption that wrapped them for peer relay (no longer needed since peers don't relay).

## Code changes

### Server (`server/src/`)

| File | Change |
|---|---|
| `types.ts` | Add `'position'` to `ClientMessage` discriminated union. Add `ClientInfo.position?: {x, y, updatedMs}` |
| `rooms.ts` | New methods: `setPosition(ws, x, y)`, `getRoomPositions(roomId): Record<name, {x, y, updatedMs}>` |
| `ws-handler.ts` | New `case 'position'` handler |
| `index.ts` | `/compute-volumes` handler accepts both old and new body shapes; routes to old `computeVolumes` or new `computeVolumesFromRoom` |
| `volumes.ts` | New `computeVolumesFromRoom(myPosition, roomId, name, rooms)` function. Skips peer positions older than `STALE_POSITION_MS` (60 s default). Old `computeVolumes(body, key)` stays |

### Server tests (`server/tests/`)

| File | Change |
|---|---|
| `rooms.test.ts` | Tests for `setPosition` / `getRoomPositions` / cleanup-on-leave |
| `volumes.test.ts` | Tests for `computeVolumesFromRoom` — basic compute, skip self, skip stale positions, skip missing positions |
| existing `computeVolumes` tests | Unchanged (back-compat path is preserved) |

### Client (`src/`)

| File | Change |
|---|---|
| `services/signaling.ts` | New `broadcastPositionToServer(x, y)` method. New `getCurrentRoom()` / `getCurrentName()` accessors |
| `services/volume-client.ts` | Update body shape: `{myPosition, roomId, name}` |
| `services/orchestrator.ts::positionTickInner` | Replace `dataChannels.getPeerBlobs()` / `dataChannels.broadcastBlob()` with `signaling.broadcastPositionToServer(...)`. New volume-client signature |
| `services/data-channel.ts` | Becomes vestigial. Leave imports in place for now; remove in a follow-up cleanup |
| `services/peer-connection.ts` | Optional: stop creating data channels. Defer to cleanup PR |

### Client tests (`tests/`)

| File | Change |
|---|---|
| `services/volume-client.test.ts` (new) | Test the new request body shape |
| Other tests | Unchanged |

## Testable behavior without production impact

What I can verify locally:

1. **All unit tests pass.** Both server (`cd server && npm test`) and client (`npm test`).
2. **Server end-to-end test.** Start local server on port `3199` with a test `ENCRYPTION_KEY`. Use a Node script to:
   - Open two WSS connections, join the same room with different names
   - Send `{type: 'position', x, y}` from each
   - POST `/compute-volumes` with new body shape from each
   - Verify pairwise volumes match expected quadratic falloff
   - Disconnect one client; verify their position is removed from subsequent volume requests
   - POST `/compute-volumes` with OLD body shape (encrypted blob) — verify back-compat path still works
3. **Stale-position cleanup.** Manually advance time, verify positions older than 60 s are skipped.
4. **Client builds clean.** `npm run build` + `npx tauri build`. Resulting exe loads without runtime errors (will fail to connect since we're not pointing it at the local server, but the bootstrap should be clean).
5. **Type safety end-to-end.** Both TypeScript projects compile in strict mode.

What I CAN'T verify locally:

- Actual LoL game with two real clients communicating through a real server.
- Real WebRTC voice path (unchanged, but worth re-verifying).
- Real CV pipeline (also unchanged, but interactive testing not possible).

## Deployment plan

When ready:

1. Push branch to GitHub for visibility.
2. User reviews the diff.
3. **Server deploy first.** Server is back-compat with old clients, so deploying it doesn't break anyone. Verifies the new code path is alive.
4. **Then ship the client release** (v0.2.0 or v0.1.34 — your call on the version bump significance). Auto-update pulls it to active users.
5. **Mixed-version window:** users on v0.1.33-or-earlier and v0.next can't hear each other. Window is ~minutes for auto-update users, longer for manual-update holdouts.
6. **Several release cycles later:** drop the back-compat path from the server (`computeVolumes` and `decryptPosition`), drop `DataChannelService` from client (or sooner, since clients can drop it the moment they're on the new version).

## What this closes

- **Issue #7** — clock-skew root cause goes away entirely. No more client timestamps in the wire format.
- **Architecture simplification** — ~150-200 LOC removed once the back-compat layer is dropped later.
- **Threat-model simplification** — the entire "encryption ceremony" justification disappears; the threat-model doc shrinks.
- **Debug surface** — one less hop, one less code path, simpler logs.

## What this doesn't fix

- CV mis-tracking (issues #7 / #13's secondary symptoms — classifier ping-pong between similar champion icons).
- WebRTC voice/connection issues (separate code path).
- Anything related to player IP exposure (Force-TURN toggle still exists, unchanged).

## Risks

- **Wire-protocol break in mixed-version sessions.** Mitigated by back-compat on the server, but users in mixed rooms during the transition will have asymmetric voice silence with cross-version peers. Tolerable for a small user base; would be a bigger deal at scale.
- **Server state grows with concurrent rooms.** Each ClientInfo now carries ~30 bytes of position data. Even at 1000 concurrent rooms × 10 clients = 300 KB. Trivial.
- **Subtle bug in stale-position cleanup.** If `ws.on('close')` doesn't fire reliably (e.g., on hard network drop), stale positions could linger. Mitigated by the 60-s STALE_POSITION_MS check on read.
- **Refactor introduces a regression.** Mitigated by keeping the old code path live during transition + comprehensive local testing before deploy.
