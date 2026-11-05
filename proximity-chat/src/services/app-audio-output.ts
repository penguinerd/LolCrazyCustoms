// "App audio" (Settings → "App audio (OBS)"): the peers' voices played by
// lolproxchat.exe itself instead of by WebView2.
//
// WebView2 plays everything from a separate msedgewebview2.exe audio process,
// which OBS's Application Audio Capture cannot pick up. With this on, each
// peer's voice goes into a Web Audio graph that outputs to no device
// (sinkId 'none'); a worklet cuts the mix into 10 ms chunks of mono f32, and
// they go to Rust (audio_out.rs), which plays them on the chosen device.
//
// Chromium only pulls a remote WebRTC track while a media element plays it, so
// each peer's <audio> element keeps playing — MUTED, which (measured with the
// Windows session meters, 2026-10-14) outputs nothing. A muted element is also
// never blocked by the autoplay policy. Peer volume is applied by a GainNode
// per peer here instead of element.volume.
//
// Echo: the browser's echo canceller only knows what the browser plays, which
// is now nothing, so with SPEAKERS the others may hear themselves back. Hence
// off by default, meant for streamers on headphones.

import { invoke } from '@tauri-apps/api/core';

/** One peer's way into the mix. */
export interface AppTap {
  setGain(value: number): void;
  disconnect(): void;
}

interface OutStatus {
  running: boolean;
  device: string | null;
  sampleRate: number;
  bufferedMs: number;
  underruns: number;
  dropped: number;
  error: string | null;
}

export interface OutDevices {
  devices: string[];
  default: string | null;
}

/** Chunks per second sent to Rust (10 ms each). */
const CHUNKS_PER_SEC = 100;
/** Consecutive failed sends after which app audio gives up. */
const MAX_SEND_FAILURES = 50;
/** How often the Rust side is checked (device lost, rate changed). */
const STATUS_POLL_MS = 2000;

// Collects the mono mix into chunks and hands them to the page.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.n = options.processorOptions.chunk;
    this.buf = new Float32Array(this.n);
    this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    for (let k = 0; k < len; k++) {
      this.buf[this.i++] = ch ? ch[k] : 0;
      if (this.i === this.n) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.n);
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export function listAppOutputDevices(): Promise<OutDevices> {
  return invoke<OutDevices>('audio_out_devices');
}

export class AppAudioOutput {
  private ctx: AudioContext | null = null;
  private mixer: GainNode | null = null;
  private tapNode: AudioWorkletNode | null = null;
  private taps = new Set<{ stream: MediaStream; gain: number; nodes: { src: MediaStreamAudioSourceNode; g: GainNode } | null }>();
  private sendFailures = 0;
  private statusTimer: number | null = null;
  private stopped = false;

  /** `onFailed`: called once if app audio stops working for good; the caller
   *  goes back to playing in the browser. */
  constructor(private readonly onFailed: (reason: string) => void) {}

  /** Opens `device` (null: the Windows default). False when it could not. */
  async start(device: string | null): Promise<boolean> {
    try {
      const st = await invoke<OutStatus>('audio_out_start', { device });
      await this.buildGraph(st.sampleRate);
      console.log('[AppAudio] Voices play from lolproxchat.exe on "' + st.device + '" at ' + st.sampleRate + ' Hz');
      this.statusTimer = window.setInterval(() => { void this.checkStatus(); }, STATUS_POLL_MS) as unknown as number;
      return true;
    } catch (e) {
      console.warn('[AppAudio] Could not start, voices stay in the browser:', e);
      await this.teardown();
      return false;
    }
  }

  /** Switches device; the graph is rebuilt if the new one runs at another rate. */
  async setDevice(device: string | null): Promise<void> {
    if (this.stopped) return;
    try {
      const st = await invoke<OutStatus>('audio_out_start', { device });
      if (this.ctx && st.sampleRate !== this.ctx.sampleRate) await this.buildGraph(st.sampleRate);
      console.log('[AppAudio] Output now "' + st.device + '" at ' + st.sampleRate + ' Hz');
    } catch (e) {
      this.fail('device switch failed: ' + e);
    }
  }

  /** A peer's voice into the mix, silent until setGain. Works for a stream
   *  that already has its audio track. */
  attach(stream: MediaStream): AppTap {
    const tap = { stream, gain: 0, nodes: null as { src: MediaStreamAudioSourceNode; g: GainNode } | null };
    this.taps.add(tap);
    this.connectTap(tap);
    return {
      setGain: (value: number) => {
        tap.gain = value;
        if (tap.nodes && this.ctx) tap.nodes.g.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
      },
      disconnect: () => {
        tap.nodes?.src.disconnect();
        tap.nodes?.g.disconnect();
        tap.nodes = null;
        this.taps.delete(tap);
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    await invoke('audio_out_stop').catch(() => { /* already gone */ });
  }

  // ---- internals ----

  private connectTap(tap: { stream: MediaStream; gain: number; nodes: { src: MediaStreamAudioSourceNode; g: GainNode } | null }): void {
    if (!this.ctx || !this.mixer || tap.stream.getAudioTracks().length === 0) return;
    const src = this.ctx.createMediaStreamSource(tap.stream);
    const g = this.ctx.createGain();
    g.gain.value = tap.gain;
    src.connect(g).connect(this.mixer);
    tap.nodes = { src, g };
  }

  /** (Re)builds the silent mixing graph at `sampleRate`, the device's. */
  private async buildGraph(sampleRate: number): Promise<void> {
    for (const tap of this.taps) { tap.nodes?.src.disconnect(); tap.nodes?.g.disconnect(); tap.nodes = null; }
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    // sinkId 'none': processed, never played by the browser.
    const ctx = new AudioContext({ sampleRate, sinkId: { type: 'none' } } as AudioContextOptions);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const mixer = ctx.createGain();
    const tapNode = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunk: Math.round(sampleRate / CHUNKS_PER_SEC) },
    });
    tapNode.port.onmessage = (e: MessageEvent<Float32Array>) => this.send(e.data);
    mixer.connect(tapNode);
    // Only so the graph is pulled; this context plays to no device.
    tapNode.connect(ctx.destination);
    this.ctx = ctx;
    this.mixer = mixer;
    this.tapNode = tapNode;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    if (ctx.state === 'suspended') {
      const resume = (): void => { void ctx.resume(); };
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
      console.warn('[AppAudio] Mix suspended until the next click or key press');
    }
    for (const tap of this.taps) this.connectTap(tap);
  }

  private send(chunk: Float32Array): void {
    if (this.stopped) return;
    invoke('audio_out_push', new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      .then(() => { this.sendFailures = 0; })
      .catch((e) => {
        if (++this.sendFailures === MAX_SEND_FAILURES) this.fail('sending audio failed: ' + e);
      });
  }

  /** Every STATUS_POLL_MS: Rust may have moved to the default device (the
   *  chosen one went away) at another rate, or stopped altogether. */
  private async checkStatus(): Promise<void> {
    if (this.stopped || !this.ctx) return;
    try {
      const st = await invoke<OutStatus>('audio_out_status');
      if (!st.running) {
        this.fail('output stopped: ' + (st.error ?? 'unknown'));
        return;
      }
      if (st.sampleRate !== this.ctx.sampleRate) {
        console.log('[AppAudio] Output moved to "' + st.device + '" at ' + st.sampleRate + ' Hz; rebuilding the mix');
        await this.buildGraph(st.sampleRate);
      }
    } catch (e) {
      this.fail('status check failed: ' + e);
    }
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    console.warn('[AppAudio] Giving up, voices go back to the browser: ' + reason);
    void this.stop();
    this.onFailed(reason);
  }

  private async teardown(): Promise<void> {
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (this.tapNode) this.tapNode.port.onmessage = null;
    for (const tap of this.taps) { tap.nodes?.src.disconnect(); tap.nodes?.g.disconnect(); tap.nodes = null; }
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.mixer = null;
    this.tapNode = null;
  }
}
