import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateTurnCredentials, generateCloudflareIceServers, _cloudflareCacheForTests } from '../src/turn.js';

describe('generateTurnCredentials', () => {
  it('should return empty iceServers when server is empty', async () => {
    const result = await generateTurnCredentials('', 'some-secret');
    expect(result).toEqual({ iceServers: [] });
  });

  it('should return empty iceServers when secret is empty', async () => {
    const result = await generateTurnCredentials('turn.example.com', '');
    expect(result).toEqual({ iceServers: [] });
  });

  it('should return exactly 4 ICE servers for valid config', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    expect(result.iceServers).toHaveLength(4);
  });

  it('should have Google STUN as first server', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    expect(result.iceServers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
  });

  it('should have TURN server with username and credential as third entry', async () => {
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    const turn = result.iceServers[2];
    expect(turn.urls).toBe('turn:turn.example.com:3478');
    expect(turn.username).toBeDefined();
    expect(turn.credential).toBeDefined();
    expect(typeof turn.username).toBe('string');
    expect(typeof turn.credential).toBe('string');
  });

  it('should have username containing future expiry (~24h from now)', async () => {
    const before = Math.floor(Date.now() / 1000) + 24 * 3600;
    const result = await generateTurnCredentials('turn.example.com', 'test-secret');
    const after = Math.floor(Date.now() / 1000) + 24 * 3600;

    const username = result.iceServers[2].username!;
    expect(username).toMatch(/^\d+:proxchat$/);

    const expiry = parseInt(username.split(':')[0]);
    expect(expiry).toBeGreaterThanOrEqual(before);
    expect(expiry).toBeLessThanOrEqual(after);
  });
});

describe('generateCloudflareIceServers', () => {
  beforeEach(() => {
    _cloudflareCacheForTests.current = null;
  });

  const mockServers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
  ];
  const okResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({ iceServers: mockServers }),
  } as Response);

  it('returns empty iceServers when keyId is empty', async () => {
    const fetchImpl = vi.fn();
    const result = await generateCloudflareIceServers('', 'tok', { fetchImpl: fetchImpl as any });
    expect(result).toEqual({ iceServers: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns empty iceServers when apiToken is empty', async () => {
    const fetchImpl = vi.fn();
    const result = await generateCloudflareIceServers('keyid', '', { fetchImpl: fetchImpl as any });
    expect(result).toEqual({ iceServers: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls Cloudflare API with correct shape and returns iceServers on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const result = await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any });
    expect(result.iceServers).toEqual(mockServers);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/v1/turn/keys/keyid/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer token');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body).ttl).toBe(24 * 3600);
  });

  it('serves from cache on subsequent calls within TTL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any });
    await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refreshes when less than 5 minutes left on the TTL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    let now = 1_000_000_000;
    await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any, now: () => now });
    // Skip to 4 minutes before expiry (refresh window is 5 minutes)
    now += (24 * 3600 - 4 * 60) * 1000;
    await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to stale cache when API fails within grace window', async () => {
    let now = 1_000_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new Error('network down'));
    const first = await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any, now: () => now });
    // Advance past expiry but within stale-grace window
    now += (24 * 3600 + 30 * 60) * 1000;
    const second = await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any, now: () => now });
    expect(second.iceServers).toEqual(first.iceServers);
  });

  it('returns empty iceServers when API fails and no usable cache', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any });
    expect(result).toEqual({ iceServers: [] });
  });

  it('returns empty iceServers when API responds non-2xx and no cache', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    const result = await generateCloudflareIceServers('keyid', 'token', { fetchImpl: fetchImpl as any });
    expect(result).toEqual({ iceServers: [] });
  });
});
