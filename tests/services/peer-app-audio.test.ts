// App audio (app-audio-output.ts) as seen from one peer: while it is on, the
// peer's <audio> element must stay muted whatever happens (it only pulls the
// track; a second audible path is what caused the double voices of #19/#21),
// and the voice's volume and mute go to its tap in the mix instead.

import { PeerConnection } from '../../src/services/peer-connection';
import type { AppAudioOutput, AppTap } from '../../src/services/app-audio-output';

class FakeAudio {
  muted = false;
  volume = 1;
  paused = true;
  autoplay = false;
  srcObject: unknown = null;
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
}

class FakeStream {
  tracks: Array<{ kind: string; stop(): void }> = [];
  addTrack(t: { kind: string; stop(): void }): void { this.tracks.push(t); }
  getAudioTracks(): Array<{ kind: string }> { return this.tracks.filter((t) => t.kind === 'audio'); }
  getTracks(): Array<{ kind: string; stop(): void }> { return this.tracks; }
}

class FakeRTCPeerConnection {
  ontrack: ((e: { track: { kind: string; stop(): void } }) => void) | null = null;
  onicecandidate = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  connectionState = 'new';
  iceConnectionState = 'new';
  close(): void { /* nothing */ }
  getReceivers(): unknown[] { return []; }
  getStats(): Promise<Map<string, unknown>> { return Promise.resolve(new Map()); }
}

interface FakeTap extends AppTap { gain: number; connected: boolean }

function fakeOut(): { out: AppAudioOutput; taps: FakeTap[] } {
  const taps: FakeTap[] = [];
  const out = {
    attach: () => {
      const tap: FakeTap = {
        gain: -1,
        connected: true,
        setGain(v: number) { tap.gain = v; },
        disconnect() { tap.connected = false; },
      };
      taps.push(tap);
      return tap;
    },
  } as unknown as AppAudioOutput;
  return { out, taps };
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeAll(() => {
  saved = { Audio: g.Audio, MediaStream: g.MediaStream, RTCPeerConnection: g.RTCPeerConnection, window: g.window, document: g.document };
  g.window = { setInterval: (f: () => void, ms: number) => setInterval(f, ms) };
  g.document = { addEventListener: () => undefined, removeEventListener: () => undefined };
  g.Audio = FakeAudio;
  g.MediaStream = FakeStream;
  g.RTCPeerConnection = FakeRTCPeerConnection;
});
afterAll(() => Object.assign(g, saved));

function makePeer(): { peer: PeerConnection; el: FakeAudio; pc: FakeRTCPeerConnection } {
  const Ctor = PeerConnection as unknown as new (name: string, ice: unknown[]) => PeerConnection;
  const peer = new Ctor('someone#tag', []);
  const anyPeer = peer as unknown as { audioElement: FakeAudio; pc: FakeRTCPeerConnection };
  return { peer, el: anyPeer.audioElement, pc: anyPeer.pc };
}

const track = () => ({ kind: 'audio', stop: () => undefined });

describe('a peer under app audio', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps its element muted and sends its volume to the tap', () => {
    jest.useFakeTimers();
    const { peer, el, pc } = makePeer();
    pc.ontrack!({ track: track() });
    peer.setVolume(0.8);
    const { out, taps } = fakeOut();
    peer.setAppOutput(out);
    expect(el.muted).toBe(true);
    expect(taps).toHaveLength(1);
    expect(taps[0].gain).toBeCloseTo(0.8);
    peer.close();
  });

  it('stays muted through the user muting and unmuting the peer; the tap carries it', () => {
    jest.useFakeTimers();
    const { peer, el, pc } = makePeer();
    pc.ontrack!({ track: track() });
    peer.setVolume(1);
    const { out, taps } = fakeOut();
    peer.setAppOutput(out);
    peer.mute();
    expect(el.muted).toBe(true);
    expect(taps[0].gain).toBe(0);
    peer.unmute();
    expect(el.muted).toBe(true);
    expect(taps[0].gain).toBeCloseTo(1);
    peer.close();
  });

  it('a track that arrives after app audio was turned on is tapped then', () => {
    jest.useFakeTimers();
    const { peer, pc } = makePeer();
    const { out, taps } = fakeOut();
    peer.setAppOutput(out);
    expect(taps).toHaveLength(0);
    pc.ontrack!({ track: track() });
    expect(taps).toHaveLength(1);
    peer.close();
  });

  it('turning app audio off gives the voice back to the element, unmuted, and drops the tap', () => {
    jest.useFakeTimers();
    const { peer, el, pc } = makePeer();
    pc.ontrack!({ track: track() });
    peer.setVolume(0.6);
    const { out, taps } = fakeOut();
    peer.setAppOutput(out);
    peer.setAppOutput(null);
    expect(el.muted).toBe(false);
    expect(el.volume).toBeCloseTo(0.6);
    expect(taps[0].connected).toBe(false);
    peer.close();
  });

  it('a peer muted by the user stays muted when app audio is turned off', () => {
    jest.useFakeTimers();
    const { peer, el, pc } = makePeer();
    pc.ontrack!({ track: track() });
    const { out } = fakeOut();
    peer.setAppOutput(out);
    peer.mute();
    peer.setAppOutput(null);
    expect(el.muted).toBe(true);
    peer.close();
  });

  it('closing the peer drops its tap', () => {
    jest.useFakeTimers();
    const { peer, pc } = makePeer();
    pc.ontrack!({ track: track() });
    const { out, taps } = fakeOut();
    peer.setAppOutput(out);
    peer.close();
    expect(taps[0].connected).toBe(false);
  });
});
