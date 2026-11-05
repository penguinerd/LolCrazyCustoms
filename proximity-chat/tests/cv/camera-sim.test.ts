// Camera mode end to end on simulated games: real base icons moving over the
// real minimap, the real TrackingService reading the frames, CameraHearing
// deciding who is heard — scored on every frame against who is actually
// inside the camera box.
//
// Needs tests/cv/fixtures-icons (scripts/fetch-minimap-icons.mjs) and
// tests/cv/fixtures-real (scripts/make-cv-fixtures.py); skips without them.

import { CameraHearing, HearingPlayer } from '../../src/services/camera-hearing';
import { newTracker, FRAME_MS, flushMicrotasks } from './harness/drive';
import {
  CameraArt,
  CameraFrameSpec,
  loadCameraArt,
  renderCameraFrame,
  SceneIcon,
  templatesFor,
  truthFor,
  lerp,
  BOX,
} from './harness/camera-scenes';

const CAST: Array<{ id: string; alias: string; side: 'ally' | 'enemy' }> = [
  { id: 'p0', alias: 'soraka', side: 'ally' }, // us
  { id: 'p1', alias: 'kalista', side: 'ally' },
  { id: 'p2', alias: 'syndra', side: 'ally' },
  { id: 'p3', alias: 'volibear', side: 'ally' },
  { id: 'p4', alias: 'briar', side: 'ally' },
  { id: 'p5', alias: 'twitch', side: 'enemy' },
  { id: 'p6', alias: 'blitzcrank', side: 'enemy' },
  { id: 'p7', alias: 'irelia', side: 'enemy' },
  { id: 'p8', alias: 'khazix', side: 'enemy' },
  { id: 'p9', alias: 'twistedfate', side: 'enemy' },
];
const SELF = 'p0';

const art: CameraArt | null = loadCameraArt(CAST.map((c) => c.alias));
const run = art && art.background ? describe : describe.skip;

type Pos = { x: number; y: number };
type Layout = Record<string, Pos | null>;

/** Where everyone stands when nothing else is said (273 px region). */
const HOME: Record<string, Pos> = {
  p0: { x: 214, y: 236 }, p1: { x: 226, y: 244 }, p2: { x: 136, y: 140 }, p3: { x: 40, y: 52 }, p4: { x: 96, y: 178 },
  p5: { x: 238, y: 214 }, p6: { x: 246, y: 226 }, p7: { x: 52, y: 34 }, p8: { x: 172, y: 92 }, p9: { x: 150, y: 128 },
};

function frame(layout: Layout, box: Pos | null): CameraFrameSpec {
  const icons: SceneIcon[] = CAST.map((c) => ({ ...c, at: c.id in layout ? layout[c.id] : HOME[c.id] }));
  return { icons, box: box ? { x0: Math.round(box.x), y0: Math.round(box.y) } : null };
}

/** A little wander, as champions never stand still in lane. */
function wander(p: Pos, i: number, seed: number, amp = 3): Pos {
  return { x: p.x + amp * Math.sin(i * 0.37 + seed), y: p.y + amp * Math.cos(i * 0.29 + seed * 1.7) };
}

interface Score {
  frames: number;
  exact: number;
  falsePos: number;
  falseNeg: number;
  shouldHear: number;
  detail: string[];
}

async function play(name: string, specs: CameraFrameSpec[], warmup = 6): Promise<Score> {
  const frames = specs.map((s) => renderCameraFrame(art!, s));
  const h = newTracker(frames);
  const hearing = new CameraHearing();
  const players: HearingPlayer[] = CAST.map((c) => ({
    id: c.id, side: c.side, self: c.id === SELF, vecs: templatesFor(art!, c.alias),
  }));
  hearing.setPlayers(players);
  const onFrame = hearing.onFrame.bind(hearing);
  let seen = 0;
  hearing.onFrame = (...args: Parameters<CameraHearing['onFrame']>): void => {
    const t0 = process.hrtime.bigint();
    onFrame(...args);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // The first frames of a scene pay for compiling the code, not for running it.
    if (++seen <= 4) return;
    cost.total += ms;
    cost.frames++;
    cost.max = Math.max(cost.max, ms);
    if (ms > 100) cost.slow++;
  };
  h.svc.setCameraHearing(hearing);
  const score: Score = { frames: 0, exact: 0, falsePos: 0, falseNeg: 0, shouldHear: 0, detail: [] };
  for (let i = 0; i < specs.length; i++) {
    jest.advanceTimersByTime(FRAME_MS);
    await h.svc.tick();
    await flushMicrotasks();
    if (i < warmup) continue;
    const heard = hearing.audible(performance.now());
    const { heard: truth, unsure } = truthFor(specs[i], SELF);
    const fp = [...heard].filter((id) => !truth.has(id) && !unsure.has(id));
    const fn = [...truth].filter((id) => !heard.has(id));
    score.frames++;
    score.shouldHear += truth.size;
    score.falsePos += fp.length;
    score.falseNeg += fn.length;
    if (fp.length === 0 && fn.length === 0) score.exact++;
    else if (score.detail.length < 6) {
      score.detail.push(`${name} f${i}: extra [${fp}] missing [${fn}] | ${hearing.describe(performance.now())}`);
    }
  }
  return score;
}

const results: Array<[string, Score]> = [];
/** Wall-clock time spent in CameraHearing.onFrame (Date/hrtime are not faked). */
const cost = { total: 0, frames: 0, max: 0, slow: 0 };

run('camera mode on simulated games (real icons, real minimap)', () => {
  let logSpy: jest.SpyInstance;
  beforeAll(() => {
    // hrtime real: it times camera mode below.
    jest.useFakeTimers({ doNotFake: ['hrtime'] });
    // The tracker narrates every lock and hold; only the scores matter here.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    const lines = results.map(([n, s]) =>
      `${n.padEnd(44)} frames ${String(s.frames).padStart(3)}  exact ${pct(s.exact, s.frames)}  ` +
      `missed ${s.falseNeg}/${s.shouldHear}  extra ${s.falsePos}`);
    lines.push(`camera mode cost: ${(cost.total / Math.max(1, cost.frames)).toFixed(2)} ms a frame on average, ` +
      `${cost.max.toFixed(1)} ms at worst, ${cost.slow} frames over 100 ms, over ${cost.frames} frames (under ts-jest)`);
    // The scores, for reading in the test output.
    console.log(['', ...lines, ...results.flatMap(([, s]) => s.detail)].join('\n'));
  });

  it('bot lane 2v2, camera on the lane: the ADC and both enemies', async () => {
    const specs = Array.from({ length: 80 }, (_, i) => frame({
      p0: wander(HOME.p0, i, 1), p1: wander(HOME.p1, i, 2),
      p5: wander(HOME.p5, i, 3), p6: wander(HOME.p6, i, 4),
    }, { x: 190, y: 205 }));
    const s = await play('bot lane 2v2', specs);
    results.push(['bot lane 2v2, camera on lane', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBeLessThanOrEqual(2);
  });

  it('bot lane trade: enemies walk into the allies and out again (icons overlapping)', async () => {
    const specs = Array.from({ length: 96 }, (_, i) => {
      const t = i < 48 ? i / 48 : (96 - i) / 48;
      return frame({
        p0: wander(HOME.p0, i, 1, 2), p1: wander(HOME.p1, i, 2, 2),
        p5: lerp(HOME.p5, { x: 222, y: 236 }, t), p6: lerp(HOME.p6, { x: 232, y: 240 }, t),
      }, { x: 190, y: 205 });
    });
    const s = await play('bot lane trade', specs);
    results.push(['bot trade (overlapping icons)', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBeLessThanOrEqual(2);
  });

  it('camera somewhere else: nobody from bot, only who is under the camera', async () => {
    const specs = Array.from({ length: 64 }, (_, i) => frame({
      p0: wander(HOME.p0, i, 1), p1: wander(HOME.p1, i, 2),
      p5: wander(HOME.p5, i, 3), p6: wander(HOME.p6, i, 4),
      p2: wander(HOME.p2, i, 5), p9: wander(HOME.p9, i, 6),
    }, { x: 105, y: 115 }));
    const s = await play('camera on mid', specs);
    results.push(['camera on mid, bot fighting', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBeLessThanOrEqual(2);
  });

  it('camera panning across the map: people come and go', async () => {
    const path = [{ x: 0, y: 10 }, { x: 110, y: 110 }, { x: 190, y: 205 }];
    const specs = Array.from({ length: 120 }, (_, i) => {
      const t = i / 119;
      const box = t < 0.5 ? lerp(path[0], path[1], t * 2) : lerp(path[1], path[2], (t - 0.5) * 2);
      return frame(Object.fromEntries(CAST.map((c, k) => [c.id, wander(HOME[c.id]!, i, k)])), box);
    });
    const s = await play('camera pan', specs);
    results.push(['camera panning top -> mid -> bot', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.07);
    expect(s.falsePos).toBeLessThanOrEqual(3);
  });

  it('an enemy steps into a brush (fog): silent until they step out', async () => {
    const specs = Array.from({ length: 96 }, (_, i) => frame({
      p0: wander(HOME.p0, i, 1), p1: wander(HOME.p1, i, 2),
      p5: i >= 32 && i < 64 ? null : wander(HOME.p5, i, 3), p6: wander(HOME.p6, i, 4),
    }, { x: 190, y: 205 }));
    const s = await play('fog', specs);
    results.push(['enemy into fog and back', s]);
    // The track outlives the icon by TRACK_TTL_MS (8 frames): those count as extra.
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBeLessThanOrEqual(9);
  });

  it('5v5 teamfight in mid, all inside the camera', async () => {
    const centre = { x: 140, y: 136 };
    const specs = Array.from({ length: 96 }, (_, i) => {
      const t = Math.min(1, i / 40);
      return frame(Object.fromEntries(CAST.map((c, k) => {
        const ang = (k / CAST.length) * Math.PI * 2;
        const spot = { x: centre.x + 26 * Math.cos(ang), y: centre.y + 14 * Math.sin(ang) };
        return [c.id, wander(lerp(HOME[c.id]!, spot, t), i, k, 2)];
      })), { x: centre.x - BOX.w / 2, y: centre.y - BOX.h / 2 });
    });
    const s = await play('teamfight', specs);
    results.push(['5v5 teamfight inside the camera', s]);
    // Accepted limit: icons on top of each other cannot all be told apart.
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.12);
    expect(s.falsePos).toBeLessThanOrEqual(3);
  });

  it('teamfight NOT in the camera: none of it is heard', async () => {
    const centre = { x: 140, y: 136 };
    const specs = Array.from({ length: 64 }, (_, i) => frame(Object.fromEntries(CAST.map((c, k) => {
      const ang = (k / CAST.length) * Math.PI * 2;
      return [c.id, wander({ x: centre.x + 22 * Math.cos(ang), y: centre.y + 12 * Math.sin(ang) }, i, k, 2)];
    })), { x: 10, y: 200 }));
    const s = await play('fight elsewhere', specs);
    results.push(['teamfight outside the camera', s]);
    expect(s.falsePos).toBe(0);
  });

  it('look-alikes crossing inside the camera (purple faces)', async () => {
    // Soraka is us; Syndra (ally) and the enemy... all purple-faced, criss-crossing.
    const a = { x: 120, y: 120 }, b = { x: 170, y: 140 };
    const specs = Array.from({ length: 80 }, (_, i) => {
      const t = (Math.sin(i / 10) + 1) / 2;
      return frame({
        p0: lerp(a, b, t), p2: lerp(b, a, t), p4: wander({ x: 145, y: 128 }, i, 7, 6),
        p9: wander({ x: 150, y: 150 }, i, 3, 8),
      }, { x: 110, y: 110 });
    });
    const s = await play('look-alikes', specs);
    results.push(['look-alikes crossing in the camera', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.1);
    expect(s.falsePos).toBeLessThanOrEqual(3);
  });

  it('camera over our base, the box clipped by the minimap corner', async () => {
    const specs = Array.from({ length: 64 }, (_, i) => frame({
      p1: wander({ x: 18, y: 250 }, i, 1, 2), p3: wander({ x: 30, y: 262 }, i, 2, 2),
      p0: wander(HOME.p0, i, 3),
    }, { x: -8, y: 273 - BOX.h + 8 }));
    const s = await play('base corner', specs);
    results.push(['camera over the base (clipped box)', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBe(0);
  });

  it('League minimised for a few seconds (no minimap): silence, then back', async () => {
    const specs = Array.from({ length: 96 }, (_, i) => {
      const f = frame({ p5: wander(HOME.p5, i, 3), p6: wander(HOME.p6, i, 4) }, { x: 190, y: 205 });
      // 4 s minimised: nothing on screen where the minimap was.
      return i >= 32 && i < 64 ? { icons: f.icons.map((c) => ({ ...c, at: null })), box: null } : f;
    });
    const s = await play('minimised', specs);
    results.push(['minimised for 4 s', s]);
    // While minimised the truth is "nobody"; the box hold + audible hold
    // allow up to 2 s (16 frames) of what was heard before.
    expect(s.falsePos).toBeLessThanOrEqual(2 * 16);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
  });

  it('an enemy dies in the camera and respawns in their base, far away', async () => {
    const specs = Array.from({ length: 96 }, (_, i) => frame({
      p5: i < 30 ? wander(HOME.p5, i, 3) : i < 70 ? null : wander({ x: 255, y: 18 }, i, 3),
      p6: wander(HOME.p6, i, 4),
    }, { x: 190, y: 205 }));
    const s = await play('death', specs);
    results.push(['enemy dies in camera, respawns at base', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.05);
    expect(s.falsePos).toBeLessThanOrEqual(9);
  });

  it('camera dragged fast over people', async () => {
    const specs = Array.from({ length: 64 }, (_, i) => {
      const box = { x: 10 + ((i * 6) % 190), y: 120 };
      return frame(Object.fromEntries(CAST.map((c, k) => [c.id, wander(HOME[c.id]!, i, k)])), box);
    });
    const s = await play('fast drag', specs);
    results.push(['camera dragged fast', s]);
    expect(s.falseNeg / Math.max(1, s.shouldHear)).toBeLessThanOrEqual(0.1);
    expect(s.falsePos).toBeLessThanOrEqual(3);
  });
});

function pct(a: number, b: number): string {
  return (b ? Math.round((100 * a) / b) : 0).toString().padStart(3) + '%';
}
