const crypto = globalThis.crypto;

export interface IceServer {
  urls: string | string[];
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
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(turnSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = Buffer.from(sig).toString('base64');

  const iceServers: IceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: `stun:${turnServer}:3478` },
    { urls: `turn:${turnServer}:3478`, username, credential },
    { urls: `turns:${turnServer}:5349`, username, credential },
  ];

  return { iceServers };
}

// ---------- Cloudflare Realtime TURN ----------
//
// Cloudflare hands out short-lived (TTL-bounded) ICE server credentials via
// a REST API. We request a 24-hour TTL and cache the response in-process,
// refreshing only when there's less than CACHE_REFRESH_LEAD_MS left so we
// avoid hammering the API on every /turn-credentials request from a client.
// If the API is unreachable but we still have a cached value within the
// stale-grace window, serve that instead — keeps us resilient to brief
// outages without handing the client empty creds mid-game.

const TURN_REQUEST_TTL_SEC = 24 * 3600;
const CACHE_REFRESH_LEAD_MS = 5 * 60 * 1000;
const CACHE_STALE_GRACE_MS = 60 * 60 * 1000;

interface CachedCloudflareCreds {
  iceServers: IceServer[];
  expiresAtMs: number;
}

// Exposed solely so tests can reset between cases. Production code must not touch it.
export const _cloudflareCacheForTests = { current: null as CachedCloudflareCreds | null };

interface CloudflareFetchOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function generateCloudflareIceServers(
  keyId: string,
  apiToken: string,
  opts: CloudflareFetchOptions = {},
): Promise<{ iceServers: IceServer[] }> {
  if (!keyId || !apiToken) {
    return { iceServers: [] };
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());

  const cached = _cloudflareCacheForTests.current;
  const timeUntilExpiryMs = cached ? cached.expiresAtMs - now() : -Infinity;
  if (cached && timeUntilExpiryMs > CACHE_REFRESH_LEAD_MS) {
    return { iceServers: cached.iceServers };
  }

  try {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_REQUEST_TTL_SEC }),
    });
    if (!resp.ok) {
      throw new Error(`Cloudflare TURN API returned ${resp.status}`);
    }
    const data = await resp.json();
    if (!Array.isArray(data?.iceServers)) {
      throw new Error('Cloudflare TURN response missing iceServers array');
    }
    _cloudflareCacheForTests.current = {
      iceServers: data.iceServers,
      expiresAtMs: now() + TURN_REQUEST_TTL_SEC * 1000,
    };
    return { iceServers: data.iceServers };
  } catch (err) {
    if (cached && now() - cached.expiresAtMs < CACHE_STALE_GRACE_MS) {
      console.warn('[turn] Cloudflare fetch failed, serving stale cached creds:', (err as Error).message);
      return { iceServers: cached.iceServers };
    }
    console.error('[turn] Cloudflare fetch failed and no usable cache:', (err as Error).message);
    return { iceServers: [] };
  }
}
