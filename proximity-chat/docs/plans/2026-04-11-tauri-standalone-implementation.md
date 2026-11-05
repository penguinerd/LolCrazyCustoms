# Tauri Standalone Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate LoLProxChat from Overwolf + Supabase to a standalone Tauri desktop app with a lightweight WebSocket signaling server.

**Architecture:** Tauri (Rust backend + WebView2 frontend) for the client. Node.js WebSocket + HTTP server replaces 13 Supabase containers. Existing TypeScript CV/WebRTC/ONNX/RNNoise code runs nearly unchanged in WebView2.

**Tech Stack:** Rust (Tauri 2.x), TypeScript, Node.js, `ws` library, `windows` crate (DXGI), WebView2, Docker

**Design doc:** `docs/plans/2026-04-11-tauri-standalone-migration.md`

---

## Phase 1: Signaling Server

Goal: Replace 13 Supabase containers with 1 custom server. Test against existing Overwolf client.

---

### Task 1.1: Scaffold Server Project

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`

**Step 1: Create server directory and initialize**

```bash
cd /e/Documents/Projects/lolproxchat
mkdir -p server/src
```

**Step 2: Create `server/package.json`**

```json
{
  "name": "proxchat-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vitest": "^3.1.0"
  }
}
```

**Step 3: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src"]
}
```

**Step 4: Create minimal `server/src/index.ts`**

```typescript
import { createServer } from 'http';

const PORT = parseInt(process.env.PORT || '3100');

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, () => {
  console.log(`proxchat-server listening on :${PORT}`);
});
```

**Step 5: Install dependencies and verify**

```bash
cd server && npm install && npm run dev &
sleep 2
curl http://localhost:3100/health
# Expected: {"status":"ok"}
kill %1
```

**Step 6: Commit**

```bash
git add server/
git commit -m "feat(server): scaffold proxchat-server project"
```

---

### Task 1.2: WebSocket Room Management

**Files:**
- Create: `server/src/rooms.ts`
- Create: `server/src/types.ts`
- Create: `server/tests/rooms.test.ts`
- Modify: `server/src/index.ts`

**Step 1: Create `server/src/types.ts`**

```typescript
export interface ClientMessage {
  type: 'join' | 'signal' | 'position';
  room?: string;
  name?: string;
  to?: string;
  payload?: any;
  blob?: string;
}

export interface ServerMessage {
  type: 'peer_joined' | 'peer_left' | 'signal' | 'position' | 'room_state' | 'error';
  name?: string;
  from?: string;
  peers?: string[];
  payload?: any;
  blob?: string;
  message?: string;
}

export interface ClientState {
  roomId: string | null;
  name: string | null;
}
```

**Step 2: Write failing test `server/tests/rooms.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from '../src/rooms.js';

describe('RoomManager', () => {
  let rooms: RoomManager;

  beforeEach(() => {
    rooms = new RoomManager();
  });

  it('should add a client to a room', () => {
    const ws = {} as any;
    rooms.join('room1', 'player1', ws);
    expect(rooms.getPeers('room1')).toEqual(['player1']);
  });

  it('should return existing peers on join', () => {
    const ws1 = {} as any;
    const ws2 = {} as any;
    rooms.join('room1', 'player1', ws1);
    rooms.join('room1', 'player2', ws2);
    expect(rooms.getPeers('room1')).toEqual(['player1', 'player2']);
  });

  it('should remove client on leave', () => {
    const ws = {} as any;
    rooms.join('room1', 'player1', ws);
    rooms.leave(ws);
    expect(rooms.getPeers('room1')).toEqual([]);
  });

  it('should clean up empty rooms', () => {
    const ws = {} as any;
    rooms.join('room1', 'player1', ws);
    rooms.leave(ws);
    expect(rooms.roomCount).toBe(0);
  });

  it('should return other clients in room for broadcast', () => {
    const ws1 = {} as any;
    const ws2 = {} as any;
    const ws3 = {} as any;
    rooms.join('room1', 'p1', ws1);
    rooms.join('room1', 'p2', ws2);
    rooms.join('room1', 'p3', ws3);
    const others = rooms.getOthersInRoom(ws1);
    expect(others.map(([name]) => name).sort()).toEqual(['p2', 'p3']);
  });

  it('should find client by name in room', () => {
    const ws1 = {} as any;
    const ws2 = {} as any;
    rooms.join('room1', 'p1', ws1);
    rooms.join('room1', 'p2', ws2);
    expect(rooms.findInRoom('room1', 'p2')).toBe(ws2);
    expect(rooms.findInRoom('room1', 'p3')).toBeUndefined();
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && npx vitest run tests/rooms.test.ts
# Expected: FAIL — RoomManager not found
```

**Step 4: Implement `server/src/rooms.ts`**

```typescript
import type WebSocket from 'ws';

interface Client {
  ws: WebSocket;
  name: string;
  roomId: string;
}

export class RoomManager {
  private rooms = new Map<string, Map<string, WebSocket>>();
  private clients = new Map<WebSocket, Client>();

  join(roomId: string, name: string, ws: WebSocket): string[] {
    // Track client
    this.clients.set(ws, { ws, name, roomId });

    // Add to room
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
    }
    this.rooms.get(roomId)!.set(name, ws);

    // Return existing peers (excluding self)
    return this.getPeers(roomId).filter(n => n !== name);
  }

  leave(ws: WebSocket): { roomId: string; name: string } | null {
    const client = this.clients.get(ws);
    if (!client) return null;

    this.clients.delete(ws);
    const room = this.rooms.get(client.roomId);
    if (room) {
      room.delete(client.name);
      if (room.size === 0) {
        this.rooms.delete(client.roomId);
      }
    }

    return { roomId: client.roomId, name: client.name };
  }

  getPeers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.keys()) : [];
  }

  getOthersInRoom(ws: WebSocket): [string, WebSocket][] {
    const client = this.clients.get(ws);
    if (!client) return [];
    const room = this.rooms.get(client.roomId);
    if (!room) return [];
    return Array.from(room.entries()).filter(([, peerWs]) => peerWs !== ws);
  }

  findInRoom(roomId: string, name: string): WebSocket | undefined {
    return this.rooms.get(roomId)?.get(name);
  }

  getClientInfo(ws: WebSocket): Client | undefined {
    return this.clients.get(ws);
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
cd server && npx vitest run tests/rooms.test.ts
# Expected: all 6 tests PASS
```

**Step 6: Commit**

```bash
git add server/src/rooms.ts server/src/types.ts server/tests/rooms.test.ts
git commit -m "feat(server): add room management with tests"
```

---

### Task 1.3: WebSocket Message Handling

**Files:**
- Modify: `server/src/index.ts`
- Create: `server/src/ws-handler.ts`

**Step 1: Create `server/src/ws-handler.ts`**

```typescript
import type WebSocket from 'ws';
import { RoomManager } from './rooms.js';
import type { ClientMessage, ServerMessage } from './types.js';

export function handleConnection(ws: WebSocket, rooms: RoomManager): void {
  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'join':
        handleJoin(ws, rooms, msg);
        break;
      case 'signal':
        handleSignal(ws, rooms, msg);
        break;
      case 'position':
        handlePosition(ws, rooms, msg);
        break;
      default:
        send(ws, { type: 'error', message: `Unknown type: ${(msg as any).type}` });
    }
  });

  ws.on('close', () => {
    const left = rooms.leave(ws);
    if (left) {
      // Notify remaining peers
      const room = rooms.getPeers(left.roomId);
      for (const peerName of room) {
        const peerWs = rooms.findInRoom(left.roomId, peerName);
        if (peerWs) {
          send(peerWs, { type: 'peer_left', name: left.name });
        }
      }
      console.log(`[${left.roomId}] ${left.name} left (${room.length} remaining)`);
    }
  });
}

function handleJoin(ws: WebSocket, rooms: RoomManager, msg: ClientMessage): void {
  if (!msg.room || !msg.name) {
    send(ws, { type: 'error', message: 'join requires room and name' });
    return;
  }

  // Leave current room if in one
  const prev = rooms.getClientInfo(ws);
  if (prev) {
    rooms.leave(ws);
  }

  const existingPeers = rooms.join(msg.room, msg.name, ws);

  // Send current room state to the joining client
  send(ws, { type: 'room_state', peers: existingPeers });

  // Notify existing peers about the new joiner
  for (const [peerName, peerWs] of rooms.getOthersInRoom(ws)) {
    send(peerWs, { type: 'peer_joined', name: msg.name });
  }

  console.log(`[${msg.room}] ${msg.name} joined (${existingPeers.length + 1} total)`);
}

function handleSignal(ws: WebSocket, rooms: RoomManager, msg: ClientMessage): void {
  const client = rooms.getClientInfo(ws);
  if (!client || !msg.to) return;

  const targetWs = rooms.findInRoom(client.roomId, msg.to);
  if (targetWs) {
    send(targetWs, { type: 'signal', from: client.name, payload: msg.payload });
  }
}

function handlePosition(ws: WebSocket, rooms: RoomManager, msg: ClientMessage): void {
  const client = rooms.getClientInfo(ws);
  if (!client || !msg.blob) return;

  for (const [, peerWs] of rooms.getOthersInRoom(ws)) {
    send(peerWs, { type: 'position', from: client.name, blob: msg.blob });
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
```

**Step 2: Update `server/src/index.ts` to wire WebSocket**

```typescript
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection } from './ws-handler.js';

const PORT = parseInt(process.env.PORT || '3100');
const rooms = new RoomManager();

const httpServer = createServer((req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.roomCount }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => handleConnection(ws, rooms));

httpServer.listen(PORT, () => {
  console.log(`proxchat-server listening on :${PORT}`);
});
```

**Step 3: Manual smoke test**

```bash
cd server && npm run dev &
sleep 2
# In a Node REPL or wscat:
# wscat -c ws://localhost:3100
# > {"type":"join","room":"test","name":"player1"}
# Expected: {"type":"room_state","peers":[]}
kill %1
```

**Step 4: Commit**

```bash
git add server/src/index.ts server/src/ws-handler.ts
git commit -m "feat(server): add WebSocket message handling (join, signal, position, presence)"
```

---

### Task 1.4: Port Volume Computation Endpoint

**Files:**
- Create: `server/src/volumes.ts`
- Create: `server/tests/volumes.test.ts`
- Modify: `server/src/index.ts`

Reference: `supabase/functions/compute-volumes/index.ts` (lines 1-141)

**Step 1: Write failing test `server/tests/volumes.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { calculateVolume, encryptPosition, decryptPosition } from '../src/volumes.js';

describe('calculateVolume', () => {
  it('returns 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('returns 0.0 at max range', () => {
    expect(calculateVolume(1200)).toBe(0.0);
  });

  it('returns 0.0 beyond max range', () => {
    expect(calculateVolume(2000)).toBe(0.0);
  });

  it('returns value between 0 and 1 at mid range', () => {
    const vol = calculateVolume(600);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });

  it('is monotonically decreasing', () => {
    const v100 = calculateVolume(100);
    const v400 = calculateVolume(400);
    const v800 = calculateVolume(800);
    expect(v100).toBeGreaterThan(v400);
    expect(v400).toBeGreaterThan(v800);
  });
});

describe('encrypt/decrypt roundtrip', () => {
  const TEST_KEY_HEX = 'a'.repeat(64); // 256-bit key

  it('roundtrips position correctly', async () => {
    const encrypted = await encryptPosition(TEST_KEY_HEX, 500, 700);
    expect(typeof encrypted).toBe('string');
    const decrypted = await decryptPosition(TEST_KEY_HEX, encrypted);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.x).toBe(500);
    expect(decrypted!.y).toBe(700);
  });

  it('rejects tampered blobs', async () => {
    const encrypted = await encryptPosition(TEST_KEY_HEX, 100, 200);
    const tampered = encrypted.slice(0, -4) + 'AAAA';
    const result = await decryptPosition(TEST_KEY_HEX, tampered);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/volumes.test.ts
# Expected: FAIL — modules not found
```

**Step 3: Implement `server/src/volumes.ts`**

Port directly from `supabase/functions/compute-volumes/index.ts`, converting from Deno to Node.js (use `node:crypto` webcrypto):

```typescript
import { webcrypto } from 'node:crypto';

const MAX_HEARING_RANGE = 1200;
const BLOB_MAX_AGE_MS = 10_000;

const keyCache = new Map<string, CryptoKey>();

async function getKey(hexKey: string): Promise<CryptoKey> {
  if (keyCache.has(hexKey)) return keyCache.get(hexKey)!;
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('Encryption key must be 64 hex chars (256-bit)');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    bytes[i / 2] = parseInt(hexKey.substring(i, i + 2), 16);
  }
  const key = await webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keyCache.set(hexKey, key);
  return key;
}

export async function encryptPosition(hexKey: string, x: number, y: number): Promise<string> {
  const key = await getKey(hexKey);
  const payload = new TextEncoder().encode(JSON.stringify({ x, y, t: Date.now() }));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptPosition(hexKey: string, blob: string): Promise<{ x: number; y: number } | null> {
  try {
    const key = await getKey(hexKey);
    const combined = Buffer.from(blob, 'base64');
    const iv = combined.subarray(0, 12);
    const ciphertext = combined.subarray(12);
    const decrypted = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    if (typeof payload.t !== 'number' || Math.abs(Date.now() - payload.t) > BLOB_MAX_AGE_MS) return null;
    return { x: payload.x, y: payload.y };
  } catch {
    return null;
  }
}

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - Math.log1p(normalized * (Math.E - 1)));
}

export interface VolumeRequest {
  myPosition: { x: number; y: number };
  peers: Record<string, string>;
}

export interface VolumeResponse {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

export async function computeVolumes(body: VolumeRequest, encryptionKey: string): Promise<VolumeResponse> {
  if (!body.myPosition || typeof body.myPosition.x !== 'number' || typeof body.myPosition.y !== 'number' ||
      !isFinite(body.myPosition.x) || !isFinite(body.myPosition.y)) {
    throw new Error('Invalid position');
  }

  const myBlob = await encryptPosition(encryptionKey, body.myPosition.x, body.myPosition.y);

  const peerVolumes: Record<string, number> = {};
  for (const [name, peerBlob] of Object.entries(body.peers || {})) {
    const peerPos = await decryptPosition(encryptionKey, peerBlob);
    if (!peerPos) {
      peerVolumes[name] = 0;
      continue;
    }
    const dx = body.myPosition.x - peerPos.x;
    const dy = body.myPosition.y - peerPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    peerVolumes[name] = calculateVolume(distance);
  }

  return { myBlob, peerVolumes };
}
```

**Step 4: Run tests**

```bash
cd server && npx vitest run tests/volumes.test.ts
# Expected: all tests PASS
```

**Step 5: Wire into HTTP server — add to `server/src/index.ts`**

Add this route handler inside the `createServer` callback, before the 404 fallback:

```typescript
  if (req.url === '/compute-volumes' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const result = await computeVolumes(parsed, ENCRYPTION_KEY);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
```

Add import and env var:
```typescript
import { computeVolumes } from './volumes.js';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
```

**Step 6: Commit**

```bash
git add server/src/volumes.ts server/tests/volumes.test.ts server/src/index.ts
git commit -m "feat(server): add volume computation endpoint (port of Edge Function)"
```

---

### Task 1.5: Port TURN Credentials Endpoint

**Files:**
- Create: `server/src/turn.ts`
- Create: `server/tests/turn.test.ts`
- Modify: `server/src/index.ts`

Reference: `supabase/functions/turn-credentials/index.ts` (lines 1-46)

**Step 1: Write failing test `server/tests/turn.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { generateTurnCredentials } from '../src/turn.js';

describe('generateTurnCredentials', () => {
  it('returns empty array when no server configured', async () => {
    const result = await generateTurnCredentials('', '');
    expect(result.iceServers).toEqual([]);
  });

  it('returns 4 ICE servers when configured', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'mysecret');
    expect(result.iceServers).toHaveLength(4);
    expect(result.iceServers[0].urls).toBe('stun:stun.l.google.com:19302');
    expect(result.iceServers[2].urls).toBe('turn:turn.example.com:3478');
    expect(result.iceServers[2]).toHaveProperty('username');
    expect(result.iceServers[2]).toHaveProperty('credential');
  });

  it('generates credentials with future expiry in username', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'secret');
    const username = result.iceServers[2].username as string;
    const [expiryStr] = username.split(':');
    const expiry = parseInt(expiryStr);
    const now = Math.floor(Date.now() / 1000);
    // Should expire ~24h from now
    expect(expiry).toBeGreaterThan(now + 23 * 3600);
    expect(expiry).toBeLessThanOrEqual(now + 25 * 3600);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npx vitest run tests/turn.test.ts
# Expected: FAIL — module not found
```

**Step 3: Implement `server/src/turn.ts`**

```typescript
import { webcrypto } from 'node:crypto';

interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export async function generateTurnCredentials(
  turnServer: string,
  turnSecret: string,
): Promise<{ iceServers: IceServer[] }> {
  if (!turnServer || !turnSecret) {
    return { iceServers: [] };
  }

  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = `${expiry}:proxchat`;
  const encoder = new TextEncoder();

  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(turnSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = Buffer.from(sig).toString('base64');

  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: `stun:${turnServer}:3478` },
      { urls: `turn:${turnServer}:3478`, username, credential },
      { urls: `turns:${turnServer}:5349`, username, credential },
    ],
  };
}
```

**Step 4: Run tests**

```bash
cd server && npx vitest run tests/turn.test.ts
# Expected: all tests PASS
```

**Step 5: Wire into HTTP server — add route to `server/src/index.ts`**

```typescript
  if (req.url === '/turn-credentials' && req.method === 'GET') {
    const result = await generateTurnCredentials(TURN_SERVER, TURN_SECRET);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
```

Add import and env vars:
```typescript
import { generateTurnCredentials } from './turn.js';
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
```

**Step 6: Commit**

```bash
git add server/src/turn.ts server/tests/turn.test.ts server/src/index.ts
git commit -m "feat(server): add TURN credentials endpoint (port of Edge Function)"
```

---

### Task 1.6: Dockerize and Deploy to Unraid

**Files:**
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Create: `docker-compose.proxchat.yml` (project root)

**Step 1: Create `server/Dockerfile`**

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "dist/index.js"]
```

**Step 2: Create `server/.dockerignore`**

```
node_modules
dist
tests
*.test.ts
```

**Step 3: Create `docker-compose.proxchat.yml` in project root**

```yaml
name: proxchat

services:
  server:
    container_name: proxchat-server
    build: ./server
    ports:
      - "3100:3100"
    environment:
      - PORT=3100
      - TURN_SERVER=${TURN_SERVER}
      - TURN_SECRET=${TURN_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3100/health').then(r=>{if(!r.ok)throw 1})"]
      interval: 30s
      timeout: 5s
      retries: 3

  coturn:
    container_name: proxchat-coturn
    image: coturn/coturn
    network_mode: host
    volumes:
      - ./coturn/turnserver.conf:/etc/turnserver.conf:ro
    restart: unless-stopped
```

**Step 4: Build and test locally**

```bash
cd /e/Documents/Projects/lolproxchat
docker compose -f docker-compose.proxchat.yml build
docker compose -f docker-compose.proxchat.yml up -d server
curl http://localhost:3100/health
# Expected: {"status":"ok","rooms":0}
docker compose -f docker-compose.proxchat.yml down
```

**Step 5: Commit**

```bash
git add server/Dockerfile server/.dockerignore docker-compose.proxchat.yml
git commit -m "feat(server): add Dockerfile and docker-compose for Unraid deployment"
```

**Step 6: Deploy to Unraid**

Copy the server directory and compose file to Unraid, set env vars (TURN_SERVER, TURN_SECRET, ENCRYPTION_KEY from existing Supabase `.env`), and bring up. Add Caddy route for `proxchat.dant123.com` → `:3100`. This is manual deployment — exact commands depend on the current coturn config on Unraid.

---

### Task 1.7: Swap Client SignalingService (Overwolf app, test against new server)

**Files:**
- Modify: `src/services/signaling.ts` (full rewrite, ~100 lines replaces ~100 lines)
- Modify: `src/core/config.ts` (replace Supabase vars with server URL)
- Modify: `src/services/volume-client.ts` (change endpoint)
- Modify: `package.json` (remove `@supabase/supabase-js`)

**Step 1: Rewrite `src/core/config.ts`**

Replace entire file:

```typescript
declare const __PROXCHAT_SERVER__: string;

export const SERVER_URL: string = typeof __PROXCHAT_SERVER__ !== 'undefined'
  ? __PROXCHAT_SERVER__
  : 'https://proxchat.dant123.com';

export const WS_URL: string = SERVER_URL.replace(/^http/, 'ws');

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const resp = await fetch(`${SERVER_URL}/turn-credentials`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.iceServers?.length > 0) return data.iceServers;
  } catch (e) {
    console.warn('[Config] Failed to fetch TURN credentials, using STUN only:', e);
  }
  return ICE_SERVERS;
}
```

**Step 2: Rewrite `src/services/signaling.ts`**

Replace entire file:

```typescript
import { WS_URL } from '../core/config';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerJoined = (name: string) => void;
type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;

export class SignalingService {
  private ws: WebSocket | null = null;
  private localName: string = '';

  joinRoom(
    roomId: string,
    localName: string,
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
    onPeerJoined?: OnPeerJoined,
  ): void {
    this.localName = localName;
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log(`[Signaling] Connected, joining room ${roomId}`);
      this.ws!.send(JSON.stringify({ type: 'join', room: roomId, name: localName }));
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'room_state':
          // Existing peers — trigger peer discovery for each
          for (const peerName of msg.peers || []) {
            onPeerJoined?.(peerName);
          }
          break;
        case 'peer_joined':
          onPeerJoined?.(msg.name);
          break;
        case 'peer_left':
          onPeerLeave(msg.name);
          break;
        case 'signal':
          onSignal({ ...msg.payload, from: msg.from, to: localName });
          break;
        case 'position':
          onPeerPosition(JSON.parse(msg.blob));
          break;
      }
    };

    this.ws.onclose = () => {
      console.log('[Signaling] Disconnected');
    };
  }

  broadcastPosition(data: PositionBroadcast): void {
    this.ws?.send(JSON.stringify({
      type: 'position',
      blob: JSON.stringify(data),
    }));
  }

  sendSignal(signal: SignalMessage): void {
    this.ws?.send(JSON.stringify({
      type: 'signal',
      to: signal.to,
      payload: { type: signal.type, payload: signal.payload },
    }));
  }

  leaveRoom(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

**Step 3: Update `src/services/volume-client.ts`**

Replace Supabase endpoint with server endpoint:

```typescript
import { Position } from '../core/types';
import { SERVER_URL } from '../core/config';

interface VolumeResponse {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

export class VolumeClient {
  private endpoint: string;

  constructor() {
    this.endpoint = `${SERVER_URL}/compute-volumes`;
  }

  async computeVolumes(
    myPosition: Position,
    peerBlobs: Record<string, string>,
  ): Promise<VolumeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myPosition: { x: myPosition.x, y: myPosition.y },
          peers: peerBlobs,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`Volume API error: ${resp.status}`);
      return resp.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
```

**Step 4: Update `webpack.config.js`**

Replace the DefinePlugin Supabase vars:

```javascript
new webpack.DefinePlugin({
  __PROXCHAT_SERVER__: JSON.stringify(process.env.PROXCHAT_SERVER || 'https://proxchat.dant123.com'),
}),
```

**Step 5: Remove Supabase dependency**

```bash
cd /e/Documents/Projects/lolproxchat
npm uninstall @supabase/supabase-js
```

**Step 6: Build and test**

```bash
npm run build
# Expected: successful build with no Supabase imports
```

**Step 7: Commit**

```bash
git add src/core/config.ts src/services/signaling.ts src/services/volume-client.ts webpack.config.js package.json package-lock.json
git commit -m "feat: replace Supabase SDK with direct WebSocket + HTTP signaling client"
```

---

## Phase 2: Tauri Shell

Goal: Scaffold Tauri project, implement Rust-side concerns (screen capture, hotkeys, game detection).

---

### Task 2.1: Scaffold Tauri Project

**Step 1: Install Tauri CLI and create project**

```bash
cd /e/Documents/Projects/lolproxchat
cargo install tauri-cli --version "^2"
cargo tauri init
# When prompted:
#   App name: ProxChat
#   Window title: ProxChat
#   Web assets path: ../dist
#   Dev server URL: http://localhost:8080
#   Dev command: npm run build -- --watch
#   Build command: npm run build:prod
```

This creates `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `src/main.rs`.

**Step 2: Configure `src-tauri/tauri.conf.json`**

Set up the overlay window and tray:

```json
{
  "app": {
    "windows": [
      {
        "label": "overlay",
        "title": "ProxChat",
        "width": 300,
        "height": 400,
        "decorations": false,
        "transparent": true,
        "alwaysOnTop": true,
        "resizable": true,
        "url": "overlay/overlay.html"
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.png"],
    "identifier": "com.proxchat.app"
  }
}
```

**Step 3: Add Rust dependencies to `src-tauri/Cargo.toml`**

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sysinfo = "0.33"
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
tokio = { version = "1", features = ["full"] }
base64 = "0.22"
windows = { version = "0.58", features = [
  "Win32_Graphics_Dxgi",
  "Win32_Graphics_Dxgi_Common",
  "Win32_Graphics_Direct3D11",
] }
```

**Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check
# Expected: compiles (possibly with warnings)
```

**Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(tauri): scaffold Tauri 2 project with overlay window config"
```

---

### Task 2.2: Implement Screen Capture (Rust)

**Files:**
- Create: `src-tauri/src/capture.rs`
- Modify: `src-tauri/src/main.rs`

This is the most technically complex piece. Uses DXGI Desktop Duplication to capture the screen, crops to the minimap region, and returns base64-encoded RGBA data to the webview.

**Step 1: Create `src-tauri/src/capture.rs`**

```rust
use base64::Engine;
use std::sync::Mutex;
use tauri::State;

pub struct CaptureState {
    pub bounds: Mutex<Option<CaptureBounds>>,
}

#[derive(Clone, serde::Deserialize)]
pub struct CaptureBounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(serde::Serialize)]
pub struct CaptureResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

/// Set the minimap crop region (called from TypeScript after calibration)
#[tauri::command]
pub fn set_capture_bounds(state: State<CaptureState>, bounds: CaptureBounds) {
    *state.bounds.lock().unwrap() = Some(bounds);
}

/// Capture the minimap region and return as base64 PNG data URL.
/// Uses Win32 BitBlt as the initial implementation (simpler than DXGI,
/// good enough for 8Hz). Can upgrade to DXGI Desktop Duplication later
/// if performance is insufficient.
#[tauri::command]
pub fn capture_minimap(state: State<CaptureState>) -> Result<CaptureResult, String> {
    let bounds = state.bounds.lock().unwrap();
    let bounds = bounds.as_ref().ok_or("Capture bounds not set")?;

    // Use win-screenshot or raw Win32 BitBlt here.
    // For now, return a placeholder — Phase 2.2 will have the full
    // DXGI/BitBlt implementation tested against a real screen.
    //
    // The actual implementation will:
    // 1. GetDC(null) for the desktop
    // 2. CreateCompatibleDC + CreateCompatibleBitmap
    // 3. BitBlt from desktop DC with crop coords
    // 4. GetDIBits to get RGBA bytes
    // 5. Encode as base64 data URL

    Err("Not yet implemented — placeholder for Phase 2.2".into())
}
```

**Note:** The full Win32 BitBlt / DXGI implementation requires testing against a live Windows desktop with League running. The exact implementation will be completed in a dedicated session with access to the game environment. The interface contract (set_capture_bounds + capture_minimap returning a data URL) is what matters for the TypeScript integration.

**Step 2: Wire into `src-tauri/src/main.rs`**

```rust
mod capture;

use capture::CaptureState;
use std::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .manage(CaptureState {
            bounds: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            capture::set_capture_bounds,
            capture::capture_minimap,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
```

**Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add src-tauri/src/capture.rs src-tauri/src/main.rs
git commit -m "feat(tauri): add screen capture command interface (Rust)"
```

---

### Task 2.3: Implement Game Detection via LCU API (Rust)

**Files:**
- Create: `src-tauri/src/lcu.rs`
- Modify: `src-tauri/src/main.rs`

**Step 1: Create `src-tauri/src/lcu.rs`**

```rust
use serde::Serialize;
use std::path::PathBuf;
use sysinfo::System;

#[derive(Clone, Serialize, Debug)]
pub struct LcuConnection {
    pub port: u16,
    pub password: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub is_league_running: bool,
    pub is_in_game: bool,
    pub summoner_name: Option<String>,
    pub is_dead: bool,
    pub game_flow_phase: String,
}

/// Find LeagueClient.exe and parse its lockfile for API credentials.
pub fn find_lcu_connection() -> Option<LcuConnection> {
    let sys = System::new_all();
    let procs: Vec<_> = sys.processes_by_name("LeagueClient".as_ref()).collect();
    if procs.is_empty() {
        return None;
    }

    // Standard lockfile locations
    let paths = [
        PathBuf::from(r"C:\Riot Games\League of Legends\lockfile"),
        PathBuf::from(r"D:\Riot Games\League of Legends\lockfile"),
    ];

    for path in &paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Format: LeagueClient:pid:port:password:protocol
            let parts: Vec<&str> = content.split(':').collect();
            if parts.len() >= 4 {
                if let Ok(port) = parts[2].parse::<u16>() {
                    return Some(LcuConnection {
                        port,
                        password: parts[3].to_string(),
                    });
                }
            }
        }
    }

    None
}

/// Poll the Live Client Data API (available during active game, no auth).
pub async fn get_live_game_data() -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    client
        .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// Poll LCU API for gameflow phase.
pub async fn get_gameflow_phase(conn: &LcuConnection) -> Option<String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;

    let url = format!("https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase", conn.port);
    let resp = client
        .get(&url)
        .basic_auth("riot", Some(&conn.password))
        .send()
        .await
        .ok()?;

    resp.json::<String>().await.ok()
}

#[tauri::command]
pub fn check_league_running() -> bool {
    find_lcu_connection().is_some()
}

#[tauri::command]
pub async fn get_game_state() -> GameState {
    let lcu = find_lcu_connection();
    let is_league_running = lcu.is_some();

    let mut state = GameState {
        is_league_running,
        is_in_game: false,
        summoner_name: None,
        is_dead: false,
        game_flow_phase: "None".into(),
    };

    if let Some(conn) = &lcu {
        if let Some(phase) = get_gameflow_phase(conn).await {
            state.game_flow_phase = phase.clone();
            state.is_in_game = phase == "InProgress";
        }
    }

    if state.is_in_game {
        if let Some(data) = get_live_game_data().await {
            if let Some(player) = data.get("activePlayer") {
                state.summoner_name = player.get("riotId")
                    .or_else(|| player.get("summonerName"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                state.is_dead = player
                    .get("isDead")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
        }
    }

    state
}
```

**Step 2: Add commands to `src-tauri/src/main.rs`**

```rust
mod capture;
mod lcu;

use capture::CaptureState;
use std::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .manage(CaptureState {
            bounds: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            capture::set_capture_bounds,
            capture::capture_minimap,
            lcu::check_league_running,
            lcu::get_game_state,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
```

**Step 3: Verify compilation**

```bash
cd src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add src-tauri/src/lcu.rs src-tauri/src/main.rs
git commit -m "feat(tauri): add LCU game detection and Live Client Data API (Rust)"
```

---

## Phase 3: Wire Everything (Tasks 3.1-3.3)

These tasks involve connecting the existing TypeScript services to the Tauri backend. Detailed implementation depends on results from Phase 2 testing with a live League environment.

### Task 3.1: Adapt Tracking Service for Tauri Screen Capture

**Files:**
- Modify: `src/services/tracking.ts` — replace `overwolf.media.getScreenshotUrl()` calls (~lines 679-745) with `invoke('capture_minimap')` from `@tauri-apps/api/core`

Key change:
```typescript
// Before (Overwolf):
(overwolf.media as any).getScreenshotUrl(params, (result) => { ... });

// After (Tauri):
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<{ data_url: string; width: number; height: number }>('capture_minimap');
const img = new Image();
img.src = result.data_url;
```

### Task 3.2: Replace GEP with LCU Events in Orchestrator

**Files:**
- Delete: `src/services/gep.ts`
- Rewrite: `src/services/game-state.ts` — poll via `invoke('get_game_state')` at 1Hz
- Modify: `src/services/orchestrator.ts` — replace all `overwolf.games.*` and GEP references with Tauri event listeners

### Task 3.3: Replace Overwolf Window Management

**Files:**
- Modify: `src/overlay/overlay.ts` — remove `overwolf.windows.*` calls, use Tauri window API
- Modify: `src/background/background.ts` — convert to Tauri app initialization entry point
- Remove: Overwolf `manifest.json`

---

## Phase 4: Polish & Ship (Tasks 4.1-4.3)

### Task 4.1: Auto-Update Pipeline

**Files:**
- Add `tauri-plugin-updater` to `src-tauri/Cargo.toml`
- Configure update endpoint in `tauri.conf.json`
- Add `/update/:version` route to `server/src/index.ts`

### Task 4.2: Installer Branding

**Files:**
- Add app icon to `src-tauri/icons/`
- Configure NSIS installer settings in `tauri.conf.json`
- Add `tauri-plugin-autostart` for "Run on startup" option

### Task 4.3: First Release

- Build with `cargo tauri build`
- Create GitHub Release with `.exe` installer
- Update wiki (LoLProxChat entity + infrastructure patterns)
- Deprecate Overwolf version

---

## Summary

| Phase | Tasks | Estimated Effort | Risk |
|-------|-------|-----------------|------|
| **1: Signaling Server** | 7 tasks | ~4-6 hours | Low |
| **2: Tauri Shell** | 3 tasks | ~6-8 hours | Medium (DXGI capture) |
| **3: Wire Everything** | 3 tasks | ~4-6 hours | Medium (integration) |
| **4: Polish & Ship** | 3 tasks | ~3-4 hours | Low |
| **Total** | 16 tasks | ~17-24 hours | |

Phase 1 is fully independent and can ship immediately (Overwolf app works against the new server). Phases 2-3 require Windows development environment with League installed for testing.
