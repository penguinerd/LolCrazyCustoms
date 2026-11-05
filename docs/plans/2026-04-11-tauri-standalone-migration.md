# LoLProxChat: Tauri Standalone + Custom Signaling Server

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Replace Overwolf platform with Tauri desktop app; replace Supabase (13 containers) with lightweight WebSocket signaling server (1 container)

## Goals

1. Ship a single Windows `.exe` — no Overwolf dependency, no app store gatekeeping
2. Reduce server footprint from 15 containers (13 Supabase + 1 coturn + 1 Caddy route) to 2 containers (signaling server + coturn)
3. Preserve all existing functionality: proximity voice, encrypted volume computation, CV minimap tracking, ONNX champion classifier, RNNoise noise suppression
4. Maintain Riot anti-cheat compliance

## Non-Goals (YAGNI)

- User accounts / authentication
- Persistent database
- Mobile or Mac support
- Multi-game support
- Centralized audio routing (stays P2P)

---

## Architecture

### Client: Tauri App (Windows)

```
┌─────────────────────────────────────────────────┐
│  Tauri Shell (Rust)                             │
│  ┌─────────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Screen       │ │ Global   │ │ Tray Icon /  │ │
│  │ Capture      │ │ Hotkeys  │ │ Auto-launch  │ │
│  │ (DXGI/BitBlt)│ │ (rdev)   │ │              │ │
│  └──────┬───────┘ └────┬─────┘ └──────────────┘ │
│         │ raw pixels    │ key events              │
│  ┌──────▼───────────────▼───────────────────────┐│
│  │  WebView2 (existing TypeScript, mostly as-is)││
│  │  ┌──────────┐ ┌────────────┐ ┌─────────────┐││
│  │  │ CV/Track  │ │ WebRTC +   │ │ ONNX +      │││
│  │  │ Pipeline  │ │ Audio      │ │ RNNoise     │││
│  │  │ (canvas)  │ │ (P2P)      │ │ (WASM)      │││
│  │  └──────────┘ └────────────┘ └─────────────┘││
│  │  ┌──────────────────────────────────────────┐││
│  │  │ Signaling Client (WebSocket, ~100 lines) │││
│  │  └──────────────────────────────────────────┘││
│  └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

#### Rust Backend Responsibilities

| Concern | Crate / Approach | Notes |
|---------|-----------------|-------|
| Screen capture | `windows` crate (DXGI Desktop Duplication) or `win-screenshot` | Crop to minimap region, return RGBA bytes to webview at ~8Hz |
| Global hotkeys | `global-hotkey` (Tauri plugin) | PTT (V hold), toggle mute (M) |
| Game detection | Poll for `LeagueClient.exe` process + read lockfile | LCU API auth: `riot:{password}` from lockfile |
| LCU API client | `reqwest` with self-signed cert ignore | Replaces Overwolf GEP for game state |
| System tray | `tauri-plugin-system-tray` | Show/hide, quit, status indicator |
| Auto-launch | `tauri-plugin-autostart` | Optional "Run on Windows startup" |
| Overlay window | Tauri window config: `always_on_top`, `transparent`, `decorations: false` | Replaces Overwolf window management |

#### WebView2 (TypeScript) — What Stays

These modules transfer nearly unchanged:

| Module | Lines | Changes Needed |
|--------|-------|---------------|
| `tracking.ts` (CV pipeline) | ~800 | Replace `overwolf.media.getScreenshotUrl()` with Tauri `invoke('capture_minimap')` → data URL |
| `champion-classifier.ts` (ONNX) | ~120 | None — ONNX Runtime Web works in WebView2 |
| `audio.ts` (WebRTC + mic) | ~300 | None — WebRTC works in WebView2 |
| `rnnoise.ts` (noise suppression) | ~80 | None — WASM works in WebView2 |
| `peer-connection.ts` (WebRTC peers) | ~176 | None |
| `data-channel.ts` (encrypted positions) | ~47 | None |
| `proximity.ts` (distance/volume math) | ~50 | None |
| `volume-client.ts` (HTTP to server) | ~40 | Change endpoint URL from Supabase Edge Function to `proxchat-server` |
| `orchestrator.ts` (state machine) | ~3000 | Replace GEP calls with Tauri event listeners; replace Overwolf window calls |
| `overlay.ts` (UI) | ~200 | Remove Overwolf window chrome, use Tauri window APIs |

#### WebView2 — What Gets Rewritten

| Module | Lines | Replacement |
|--------|-------|------------|
| `signaling.ts` (Supabase Realtime) | ~80 | Plain WebSocket client (~100 lines) |
| `gep.ts` (Overwolf Game Events) | ~60 | Remove — replaced by Rust LCU polling |
| `game-state.ts` (GEP data parsing) | ~100 | Rewrite to parse LCU API JSON instead of GEP events |
| `config.ts` (Supabase credentials) | ~30 | Replace with server URL config |

#### Screen Capture Flow

```
Rust (8Hz timer):
  1. DXGI Desktop Duplication → full screen frame
  2. Crop to minimap bounds (bottom-right region)
  3. Encode as base64 data URL (or use shared memory for performance)
  4. Emit Tauri event: "minimap-frame" → WebView2

TypeScript (unchanged CV pipeline):
  1. Receive data URL → create Image → draw to canvas
  2. getImageData() → classifyPixel() → dilate() → findBlobs()
  3. filterIconBlobs() → classifierScoring() → lock position
  4. (rest of pipeline identical)
```

#### Game Detection & State (replacing GEP)

```
Rust (1Hz poll):
  1. Check if LeagueClient.exe is running (sysinfo crate)
  2. If found, read lockfile: C:\Riot Games\League of Legends\lockfile
     → parse: process:pid:port:password:protocol
  3. Poll LCU: GET https://127.0.0.1:{port}/lol-gameflow/v1/session
     → Headers: Authorization: Basic riot:{password}
  4. Emit state changes to WebView2 as Tauri events

Live Client Data API (during active game, no auth needed):
  GET https://127.0.0.1:2999/liveclientdata/allgamedata
  → activePlayer: { summonerName, isDead, level, ... }
  → allPlayers: [{ summonerName, team, championName, ... }]
```

| GEP Event | LCU / Live Client Equivalent |
|-----------|------------------------------|
| Game start | Gameflow state → `InProgress` |
| Summoner info | `/lol-summoner/v1/current-summoner` |
| Teams / players | Live Client Data → `allPlayers` |
| Death | Live Client Data → `activePlayer.isDead` |
| Respawn | `isDead` transitions false→true |
| Match end | Gameflow state → `EndOfGame` |
| Champion select | `/lol-champ-select/v1/session` |

---

### Server: proxchat-server (1 container)

Replaces 13 Supabase containers with a single lightweight process.

```
┌──────────────────────────────────────────────────┐
│  proxchat-server (Node.js or Bun)                │
│                                                  │
│  WebSocket Server (ws or uWebSockets.js)         │
│  ├── Room management                             │
│  │   ├── join(roomId, playerName)                │
│  │   ├── leave(roomId, playerName)               │
│  │   └── rooms: Map<roomId, Set<WebSocket>>      │
│  ├── Message relay                               │
│  │   ├── broadcast to room (position updates)    │
│  │   └── targeted relay (WebRTC signaling)       │
│  └── Presence                                    │
│      └── on disconnect → broadcast 'leave' event │
│                                                  │
│  HTTP Endpoints                                  │
│  ├── POST /compute-volumes                       │
│  │   (AES-GCM decrypt → distance → volume)       │
│  │   (direct port of Edge Function, ~141 lines)  │
│  ├── GET /turn-credentials                       │
│  │   (HMAC-SHA1 for coturn, ~46 lines)           │
│  ├── GET /health                                 │
│  └── GET /update/{version} (Tauri update check)  │
│                                                  │
│  Total: ~300-400 lines                           │
└──────────────────────────────────────────────────┘
```

#### WebSocket Protocol

```typescript
// Client → Server
{ type: 'join', room: string, name: string }
{ type: 'signal', to: string, payload: RTCSessionDescription | RTCIceCandidate }
{ type: 'position', blob: string }  // encrypted, broadcast to room

// Server → Client
{ type: 'peer_joined', name: string }
{ type: 'peer_left', name: string }
{ type: 'signal', from: string, payload: any }
{ type: 'position', from: string, blob: string }
{ type: 'room_state', peers: string[] }  // on join, current room members
```

#### Deployment (Unraid)

```yaml
# docker-compose.yml (replaces lolproxchat compose project)
services:
  proxchat-server:
    build: ./server
    ports:
      - "3100:3100"    # WebSocket + HTTP
    environment:
      - TURN_SERVER=192.168.0.10
      - TURN_SECRET=${TURN_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    restart: unless-stopped

  coturn:
    image: coturn/coturn
    # ... (unchanged from current config)
```

Caddy route: `proxchat.dant123.com` → `:3100` (WebSocket upgrade + HTTP)

---

## Packaging & Distribution

| Aspect | Detail |
|--------|--------|
| **Output** | `proxchat-setup.exe` (~15-20MB) via `cargo tauri build` |
| **Installer** | NSIS (Tauri default) — Start Menu shortcut, optional auto-start |
| **WebView2** | Auto-bootstraps if missing (pre-installed on Win 10 21H2+ and all Win 11) |
| **Bundled assets** | champion_classifier.onnx (~2MB), champion_labels.json, WASM files (ONNX Runtime, RNNoise) |
| **Auto-update** | Tauri updater plugin → checks `proxchat.dant123.com/update/{version}` on launch |
| **Distribution** | GitHub Releases + direct download from project site |

---

## Anti-Cheat Compliance

| Method | Riot Policy | Status |
|--------|------------|--------|
| Live Client Data API (localhost:2999) | Officially documented, explicitly allowed | ✅ Compliant |
| LCU API (localhost:{port}) | Official API, used by many community tools | ✅ Compliant |
| Screen capture (minimap) | Reads publicly visible screen content | ✅ Compliant |
| No process injection | App never touches League process memory | ✅ Compliant |
| No packet inspection | All data from official APIs or screen | ✅ Compliant |

**Note:** Overwolf apps have an explicit Riot partnership. Standalone apps operate under Riot's general third-party policy. The Live Client Data API and LCU API are both officially supported for community developers.

---

## Migration Phases

### Phase 1: Signaling Server
Build and deploy `proxchat-server` on Unraid. Test with existing Overwolf app by swapping SignalingService from Supabase to WebSocket. Validate rooms, presence, signaling, volume computation, TURN credentials all work. Then tear down the 13 Supabase containers.

**Deliverables:** proxchat-server container running, Overwolf app works against it
**Risk:** Low — server is simple, client change is one file

### Phase 2: Tauri Shell
Scaffold Tauri project. Implement Rust-side: screen capture (DXGI), global hotkeys, game detection (LCU), tray icon, overlay window. Get WebView2 rendering the overlay HTML.

**Deliverables:** Tauri app launches, detects League, captures minimap, shows overlay
**Risk:** Medium — DXGI capture + minimap crop is the most technically complex piece

### Phase 3: Wire Everything
Move TypeScript services into the Tauri webview. Connect screen capture → CV pipeline → position tracking → encrypted volumes → WebRTC audio. Replace GEP event parsing with LCU API data. Connect signaling client.

**Deliverables:** Full proximity voice working in Tauri app
**Risk:** Medium — integration testing across Rust↔WebView2 boundary

### Phase 4: Polish & Ship
Auto-update, installer branding, first-run calibration wizard, error handling, reconnection logic, performance profiling. Publish to GitHub Releases.

**Deliverables:** v1.0 release, auto-update pipeline, Overwolf version deprecated
**Risk:** Low — polish work, no new architecture

---

## Resource Impact

| Metric | Before (Supabase) | After (proxchat-server) |
|--------|-------------------|------------------------|
| Containers | 15 (13 Supabase + coturn + Caddy route) | 2 (server + coturn) |
| RAM (estimated) | ~1-2GB (PostgreSQL, Kong, etc.) | ~50-100MB |
| Docker images | ~5GB total | ~200MB total |
| Complexity | Full platform (auth, DB, storage, analytics unused) | Purpose-built (~400 lines) |
| External dependency | Supabase SDK + Edge Functions runtime | None (plain WebSocket + HTTP) |
