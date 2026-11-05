import {
  AUDIBLE_HOLD_MS,
  CameraHearing,
  COVERED_MAX_MS,
  HearingPlayer,
  IconObservation,
  IDENTIFY_INTERVAL_MS,
  iconsInBlob,
  isMergedIcons,
  matchSets,
  TRACK_TTL_MS,
} from '../../src/services/camera-hearing';
import { expectedBoxSize } from '../../src/services/camera-box';
import type { CaptureFrame } from '../../src/core/capture-frame';
import type { Blob } from '../../src/services/blob-types';

// A 341 px minimap at the capture's origin; icons 30 px across.
const SIDE = 341;
const REGION = { x: 0, y: 0, width: SIDE, height: SIDE };
const { w: BW, h: BH } = expectedBoxSize(SIDE);
const FRAME = { data: new Uint8ClampedArray(SIDE * SIDE * 4), width: SIDE, height: SIDE } as unknown as CaptureFrame;

// p0 is us; p1-p4 our team; p5-p9 theirs.
const PLAYERS: HearingPlayer[] = [
  { id: 'p0', side: 'ally', self: true, vecs: [] },
  ...[1, 2, 3, 4].map((i) => ({ id: 'p' + i, side: 'ally' as const, vecs: [] })),
  ...[5, 6, 7, 8, 9].map((i) => ({ id: 'p' + i, side: 'enemy' as const, vecs: [] })),
];

function boxMask(x0: number, y0: number): Uint8Array {
  const m = new Uint8Array(SIDE * SIDE);
  for (let x = x0; x <= x0 + BW; x++) { m[y0 * SIDE + x] = 1; m[(y0 + BH) * SIDE + x] = 1; }
  for (let y = y0; y <= y0 + BH; y++) { m[y * SIDE + x0] = 1; m[y * SIDE + x0 + BW] = 1; }
  return m;
}

/** Camera box with its top-left at (100, 100): x 100..185, y 100..147. */
const BOX = { x0: 100, y0: 100 };
const IN = { x: 140, y: 120 };
const OUT = { x: 300, y: 300 };

function setup(): { h: CameraHearing; at: (now: number, obs: IconObservation[], box?: { x0: number; y0: number } | null) => Set<string> } {
  const h = new CameraHearing(30);
  h.setPlayers(PLAYERS);
  const at = (now: number, obs: IconObservation[], box: { x0: number; y0: number } | null = BOX): Set<string> => {
    h.onFrame(FRAME, REGION, [], [], box ? boxMask(box.x0, box.y0) : new Uint8Array(SIDE * SIDE), now);
    h.ingest(obs, now);
    return h.audible(now);
  };
  return { h, at };
}

const ally = (x: number, y: number, id: string | null = null, scores?: Record<string, number>): IconObservation =>
  ({ side: 'ally', x, y, id, scores: scores ? new Map(Object.entries(scores)) : undefined });
const enemy = (x: number, y: number, id: string | null = null, scores?: Record<string, number>): IconObservation =>
  ({ side: 'enemy', x, y, id, scores: scores ? new Map(Object.entries(scores)) : undefined });

const ids = (s: Set<string>): string[] => [...s].sort();

describe('CameraHearing: who is heard', () => {
  it('hears the named icons inside the box, of both teams, and nobody outside it', () => {
    const { at } = setup();
    const heard = at(0, [ally(IN.x, IN.y, 'p1'), enemy(IN.x + 20, IN.y + 10, 'p5'), ally(OUT.x, OUT.y, 'p2'), enemy(20, 20, 'p6')]);
    expect(ids(heard)).toEqual(['p1', 'p5']);
  });

  it('never plays our own voice back, though our icon is in the box', () => {
    const { at } = setup();
    expect(ids(at(0, [ally(IN.x, IN.y, 'p0'), ally(IN.x + 30, IN.y, 'p1')]))).toEqual(['p1']);
  });

  it('counts an icon half inside the box, not one clearly outside', () => {
    const { at } = setup();
    // Box x 100..185; margin is a quarter icon (7.5 px).
    expect(ids(at(0, [ally(94, 120, 'p1'), ally(80, 120, 'p2')]))).toEqual(['p1']);
  });

  it('stops hearing someone who walks out of the box', () => {
    const { at } = setup();
    expect(ids(at(0, [enemy(180, 120, 'p5')]))).toEqual(['p5']);
    expect(ids(at(250, [enemy(195, 120)]))).toEqual([]);
  });

  it('stops hearing someone when the camera moves off them', () => {
    const { at } = setup();
    expect(ids(at(0, [enemy(IN.x, IN.y, 'p5')]))).toEqual(['p5']);
    expect(ids(at(250, [enemy(IN.x, IN.y)], { x0: 220, y0: 220 }))).toEqual([]);
  });

  it('hears nobody the minimap does not draw (fog of war): no icon, no voice', () => {
    const { at } = setup();
    expect(ids(at(0, [enemy(IN.x, IN.y, 'p5')]))).toEqual(['p5']);
    // p5 walks into a brush: the icon is gone. After the track expires, silent.
    expect(ids(at(250 + TRACK_TTL_MS + 1, []))).toEqual([]);
  });
});

describe('CameraHearing: names that survive being covered', () => {
  it('keeps a name on an icon that moves on unrecognised (under another icon)', () => {
    const { at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    expect(ids(at(250, [enemy(IN.x + 4, IN.y + 2)]))).toEqual(['p5']);
    expect(ids(at(500, [enemy(IN.x + 8, IN.y + 4, null, { p5: 0.3, p6: 0.35 })]))).toEqual(['p5']);
  });

  it('drops the name when the icon now clearly looks like someone else', () => {
    const { at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    // Not a decision (no id), but p7 beats p5 by 0.3+: not p5 any more.
    const heard = at(250, [enemy(IN.x + 2, IN.y, null, { p5: 0.2, p6: 0.1, p7: 0.6, p8: 0.1, p9: 0.1 })]);
    expect(heard.has('p5')).toBe(false);
  });

  it('moves a name to where the player was just recognised', () => {
    const { h, at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    // p5 recognised far away (out of the box): the icon in the box is not p5.
    at(250, [enemy(IN.x, IN.y), enemy(OUT.x, OUT.y, 'p5', { p5: 0.9 })]);
    expect(h.describe(250)).toContain('E:p5@300,300');
    expect(h.describe(250)).toContain('E:?@140,120*');
  });

  it('does not move a name across the map on a weak match (two icons stacked can look like a third)', () => {
    const { h, at } = setup();
    at(0, [enemy(OUT.x, OUT.y, 'p7')]);
    const heard = at(250, [enemy(OUT.x, OUT.y), enemy(IN.x, IN.y, 'p7', { p7: 0.65, p5: 0.4 })]);
    expect(h.describe(250)).toContain('E:p7@300,300');
    expect(heard.has('p7')).toBe(false);
  });

  it('keeps an enemy covered by an ally icon while a sliver of its ring shows', () => {
    const { at, h } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    const sliver = { side: 'enemy' as const, minX: IN.x + 8, maxX: IN.x + 14, minY: IN.y - 4, maxY: IN.y + 6 };
    for (let t = 250; t <= 5000; t += 250) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(IN.x - 2, IN.y, 'p1')], t, [sliver]);
    }
    expect(ids(h.audible(5000))).toEqual(['p1', 'p5']);
  });

  it('holds an enemy that vanished right under an ally icon, ring or not, for COVERED_MAX_MS at most', () => {
    const { at, h } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5'), ally(IN.x - 2, IN.y, 'p1')]);
    let t = 250;
    for (; t <= 3000; t += 250) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(IN.x - 2, IN.y, 'p1')], t, []);
    }
    expect(ids(h.audible(3000))).toEqual(['p1', 'p5']);
    // It may have stepped into a brush beside the ally instead: not forever.
    for (; t <= COVERED_MAX_MS + 2000; t += 250) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(IN.x - 2, IN.y, 'p1')], t, []);
    }
    expect(ids(h.audible(t - 250))).toEqual(['p1']);
  });

  it('lets an enemy go that vanished beside an ally icon, not under it (stepped into the fog)', () => {
    const { at, h } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5'), ally(IN.x - 30, IN.y, 'p1')]);
    for (let t = 250; t <= 3000; t += 250) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(IN.x - 30, IN.y, 'p1')], t, []);
    }
    expect(ids(h.audible(3000))).toEqual(['p1']);
  });

  it('does not hold a covered track forever', () => {
    const { at, h } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    const sliver = { side: 'enemy' as const, minX: IN.x, maxX: IN.x + 6, minY: IN.y, maxY: IN.y + 6 };
    let t = 250;
    for (; t <= 12000; t += 250) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([], t, [sliver]);
    }
    expect(h.audible(t).has('p5')).toBe(false);
  });

  it('does not continue an enemy track with an ally icon', () => {
    const { at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    const heard = at(250, [ally(IN.x + 1, IN.y, null)]);
    // The enemy icon is gone from the minimap; the ally one is unnamed and is
    // settled by elimination among allies, never as p5.
    expect(heard.has('p5')).toBe(true); // p5's track is still live (TTL)
    expect(ids(at(250 + TRACK_TTL_MS + 1, [ally(IN.x + 1, IN.y, 'p1')]))).toEqual(['p1']);
  });
});

describe('CameraHearing: unknown icons, settled by elimination', () => {
  it('an unknown enemy icon in the box is the one enemy not named elsewhere', () => {
    const { at } = setup();
    const heard = at(0, [
      enemy(IN.x, IN.y),
      enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 40, 'p7'), enemy(250, 250, 'p8'),
    ]);
    expect(ids(heard)).toEqual(['p9']);
  });

  it('as many unknown icons as players left: all of them', () => {
    const { at } = setup();
    const heard = at(0, [
      enemy(IN.x, IN.y), enemy(IN.x + 30, IN.y),
      enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 40, 'p7'),
    ]);
    expect(ids(heard)).toEqual(['p8', 'p9']);
  });

  it('more players left than unknown icons: whoever each looked most like', () => {
    const { at } = setup();
    const heard = at(0, [enemy(IN.x, IN.y, null, { p5: 0.2, p6: 0.45, p7: 0.3, p8: 0.1, p9: 0.25 })]);
    expect(ids(heard)).toEqual(['p6']);
  });

  it('two unknown icons do not both become the same player', () => {
    const { at } = setup();
    const heard = at(0, [
      enemy(IN.x, IN.y, null, { p5: 0.5, p6: 0.45 }),
      enemy(IN.x + 30, IN.y, null, { p5: 0.55, p6: 0.4 }),
    ]);
    expect(heard.size).toBe(2);
  });

  it('an unknown icon never matched, with nothing to tell who it is, is nobody rather than everyone left', () => {
    const { at } = setup();
    const heard = at(0, [enemy(IN.x, IN.y), enemy(20, 20, 'p5'), enemy(40, 300, 'p6')]);
    expect(ids(heard)).toEqual([]);
  });

  it('an unknown icon never matched is the player left who was last named nearest it', () => {
    const { at } = setup();
    at(0, [enemy(IN.x - 10, IN.y, 'p7'), enemy(20, 20, 'p8'), enemy(300, 40, 'p9')]);
    // All three walk into a merged blob / fog; one unnamed icon shows in the box.
    const heard = at(250 + TRACK_TTL_MS, [enemy(IN.x, IN.y)]);
    expect(ids(heard)).toEqual(['p7']);
  });

  it('two unknown icons in a pile-up make two players audible, never four (16:27:54 of the 2026-10-13 game)', () => {
    const { at } = setup();
    const heard = at(0, [enemy(IN.x, IN.y), enemy(IN.x + 8, IN.y), enemy(20, 20, 'p5')]);
    expect(heard.size).toBeLessThanOrEqual(2);
  });

  it('a pile-up of as many unknown icons as players left, all reachable: all of them', () => {
    const { at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p8'), enemy(IN.x + 10, IN.y, 'p9'), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 40, 'p7')]);
    const heard = at(250, [enemy(IN.x + 4, IN.y), enemy(IN.x + 6, IN.y), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 40, 'p7')]);
    expect(ids(heard)).toEqual(['p8', 'p9']);
  });

  it('a dead player is never the unknown icon in the box', () => {
    const { h, at } = setup();
    h.setDead(['p9']);
    const heard = at(0, [
      enemy(IN.x, IN.y, null, { p5: 0.1, p6: 0.1, p7: 0.1, p8: 0.2, p9: 0.6 }),
      enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 40, 'p7'),
    ]);
    expect(ids(heard)).toEqual(['p8']);
  });

  it('a dead player is not heard, even on a track still carrying their name', () => {
    const { h, at } = setup();
    expect(ids(at(0, [enemy(IN.x, IN.y, 'p5')]))).toEqual(['p5']);
    h.setDead(['p5']);
    expect(ids(at(250, []))).toEqual([]);
  });

  it('nobody is the unknown icon who was named across the map a moment ago (no teleports)', () => {
    const { at } = setup();
    // p9 seen far away (top-right), then lost in the fog.
    at(0, [enemy(320, 20, 'p9'), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 300, 'p7'), enemy(250, 250, 'p8')]);
    // A second later an unknown icon looking most like p9 shows in the box.
    const heard = at(1000, [enemy(IN.x, IN.y, null, { p9: 0.6 }), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 300, 'p7'), enemy(250, 250, 'p8')]);
    expect(heard.has('p9')).toBe(false);
  });

  it('...but could be them once they had time to walk here', () => {
    const { at } = setup();
    at(0, [enemy(320, 20, 'p9'), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 300, 'p7'), enemy(250, 250, 'p8')]);
    const later = 20000;
    const heard = at(later, [enemy(IN.x, IN.y, null, { p9: 0.6 }), enemy(20, 20, 'p5'), enemy(40, 300, 'p6'), enemy(300, 300, 'p7'), enemy(250, 250, 'p8')]);
    expect(ids(heard)).toEqual(['p9']);
  });

  it('after a recall our own unrecognised icon in the fountain is us, not a teammate (16:41:08 of the 2026-10-13 game)', () => {
    const { at } = setup();
    // We are named in lane; p1 is far away, p2-p4 named elsewhere.
    const mates = [ally(40, 300, 'p2'), ally(40, 40, 'p3'), ally(250, 250, 'p4')];
    at(0, [ally(IN.x, IN.y, 'p0'), ally(20, 300, 'p1'), ...mates]);
    // Recall: camera on the fountain, our icon there unrecognised and looking
    // more like p1 than like us; p1 is not on the map any more (dead or gone
    // where we cannot see), p2-p4 still where they were.
    const fountain = { x0: 250, y0: 10 };
    const heard = at(TRACK_TTL_MS + 500, [ally(300, 30, null, { p0: 0.2, p1: 0.4, p2: 0.1, p3: 0.1, p4: 0.1 }), ...mates], fountain);
    expect(ids(heard)).toEqual([]);
  });

  it('our own unrecognised icon in the box does not make a teammate audible', () => {
    const { at } = setup();
    // Allies p1-p4 are all named elsewhere: the unknown ally icon in the box
    // can only be us.
    const heard = at(0, [
      ally(IN.x, IN.y),
      ally(20, 20, 'p1'), ally(40, 300, 'p2'), ally(300, 40, 'p3'), ally(250, 250, 'p4'),
    ]);
    expect(ids(heard)).toEqual([]);
  });

  it('our own icon, unrecognised but looking like us, is still us', () => {
    const { at } = setup();
    const heard = at(0, [ally(IN.x, IN.y, null, { p0: 0.5, p1: 0.2, p2: 0.1, p3: 0.1, p4: 0.1 })]);
    expect(ids(heard)).toEqual([]);
  });
});

describe('CameraHearing: teammates piled on one icon (only the top one shows)', () => {
  /** Runs frames every IDENTIFY_INTERVAL_MS from `from` to `to`, all showing `obs`. */
  function hold(h: CameraHearing, from: number, to: number, obs: IconObservation[], box = BOX): Set<string> {
    let t = from;
    for (; t <= to; t += IDENTIFY_INTERVAL_MS) {
      h.onFrame(FRAME, REGION, [], [], boxMask(box.x0, box.y0), t);
      h.ingest(obs, t);
    }
    return h.audible(t - IDENTIFY_INTERVAL_MS);
  }

  it('keeps hearing a teammate whose icon is fully under another one in the box', () => {
    const { h, at } = setup();
    expect(ids(at(0, [ally(IN.x, IN.y, 'p1'), ally(IN.x + 25, IN.y, 'p2')]))).toEqual(['p1', 'p2']);
    // p2 walks onto p1: one icon left, p1's. Long after p2's track expired:
    const heard = hold(h, 250, 5000, [ally(IN.x + 1, IN.y, 'p1')]);
    expect(ids(heard)).toEqual(['p1', 'p2']);
  });

  it('three of us on one pixel: still hears both teammates under the one icon', () => {
    const { h, at } = setup();
    at(0, [ally(IN.x, IN.y, 'p0'), ally(IN.x + 20, IN.y, 'p1'), ally(IN.x + 10, IN.y + 15, 'p2')]);
    const heard = hold(h, 250, 4000, [ally(IN.x + 5, IN.y + 5, 'p0')]);
    expect(ids(heard)).toEqual(['p1', 'p2']);
  });

  it('the hidden teammate goes where the pile goes: out of the camera, and back in', () => {
    const { h, at } = setup();
    at(0, [ally(IN.x, IN.y, 'p1'), ally(IN.x + 20, IN.y, 'p2')]);
    hold(h, 250, 2000, [ally(IN.x + 2, IN.y, 'p1')]);
    // The pile walks out of the box, a few pixels a frame...
    let x = IN.x + 2;
    let t = 2250;
    for (; x < 230; x += 3, t += IDENTIFY_INTERVAL_MS) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(x, IN.y, 'p1')], t);
    }
    expect(ids(h.audible(t - IDENTIFY_INTERVAL_MS))).toEqual([]);
    // ...and the camera follows it.
    const box2 = { x0: 180, y0: 100 };
    h.onFrame(FRAME, REGION, [], [], boxMask(box2.x0, box2.y0), t);
    h.ingest([ally(x, IN.y, 'p1')], t);
    expect(ids(h.audible(t))).toEqual(['p1', 'p2']);
  });

  it('the hidden teammate showing again beside the pile is that new icon', () => {
    const { h, at } = setup();
    at(0, [ally(IN.x, IN.y, 'p1'), ally(IN.x + 20, IN.y, 'p2')]);
    hold(h, 250, 2000, [ally(IN.x + 2, IN.y, 'p1')]);
    // An unknown icon steps out of the pile, then walks out of the box.
    hold(h, 2250, 2250, [ally(IN.x + 2, IN.y, 'p1'), ally(IN.x + 30, IN.y)]);
    let x = IN.x + 30;
    let t = 2500;
    for (; x < 230; x += 3, t += IDENTIFY_INTERVAL_MS) {
      h.onFrame(FRAME, REGION, [], [], boxMask(BOX.x0, BOX.y0), t);
      h.ingest([ally(IN.x + 2, IN.y, 'p1'), ally(x, IN.y)], t);
    }
    expect(ids(h.audible(t - IDENTIFY_INTERVAL_MS))).toEqual(['p1']);
  });

  it('a hidden teammate who recalls and is recognised in the fountain is not heard at the pile', () => {
    const { h, at } = setup();
    at(0, [ally(IN.x, IN.y, 'p1'), ally(IN.x + 20, IN.y, 'p2')]);
    hold(h, 250, 2000, [ally(IN.x + 2, IN.y, 'p1')]);
    const heard = hold(h, 2250, 2500, [ally(IN.x + 2, IN.y, 'p1'), ally(320, 20, 'p2', { p2: 0.9 })]);
    expect(ids(heard)).toEqual(['p1']);
  });

  it('a hidden teammate who dies is not heard', () => {
    const { h, at } = setup();
    at(0, [ally(IN.x, IN.y, 'p1'), ally(IN.x + 20, IN.y, 'p2')]);
    hold(h, 250, 2000, [ally(IN.x + 2, IN.y, 'p1')]);
    h.setDead(['p2']);
    expect(ids(hold(h, 2250, 2500, [ally(IN.x + 2, IN.y, 'p1')]))).toEqual(['p1']);
  });
});

describe('CameraHearing: losing the camera box or the minimap', () => {
  it('holds what it heard for AUDIBLE_HOLD_MS with no box, then hears nobody', () => {
    const { h, at } = setup();
    expect(ids(at(0, [enemy(IN.x, IN.y, 'p5')]))).toEqual(['p5']);
    // No box from here on (the box tracker itself holds it 1 s first).
    const t1 = 2000;
    h.onFrame(FRAME, REGION, [], [], new Uint8Array(SIDE * SIDE), t1);
    expect(h.getBox()).toBeNull();
    expect(ids(h.audible(t1))).toEqual([]);
  });

  it('keeps hearing through a short gap in the box', () => {
    const { h, at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    h.onFrame(FRAME, REGION, [], [], new Uint8Array(SIDE * SIDE), 500);
    expect(h.getBox()).not.toBeNull();
    expect(ids(h.audible(500))).toEqual(['p5']);
  });

  it('box held, then box gone but voices held, then silence', () => {
    const { h, at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    const none = new Uint8Array(SIDE * SIDE);
    // The box tracker holds the box for a second...
    h.onFrame(FRAME, REGION, [], [], none, 900);
    expect(ids(h.audible(900))).toEqual(['p5']);
    // ...then lets go, and what was heard last carries on AUDIBLE_HOLD_MS...
    h.onFrame(FRAME, REGION, [], [], none, 1500);
    expect(h.getBox()).toBeNull();
    expect(ids(h.audible(1500))).toEqual(['p5']);
    // ...then nobody.
    h.onFrame(FRAME, REGION, [], [], none, 900 + AUDIBLE_HOLD_MS + 1);
    expect(ids(h.audible(900 + AUDIBLE_HOLD_MS + 1))).toEqual([]);
  });

  it('reset() forgets everything', () => {
    const { h, at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    h.reset();
    expect(h.getBox()).toBeNull();
    expect(ids(h.audible(10))).toEqual([]);
    expect(h.describe(10)).toBe('');
  });

  it('forgets tracks not seen for TRACK_TTL_MS', () => {
    const { at } = setup();
    at(0, [enemy(IN.x, IN.y, 'p5')]);
    expect(ids(at(TRACK_TTL_MS, []))).toEqual(['p5']);
    expect(ids(at(TRACK_TTL_MS + IDENTIFY_INTERVAL_MS + 1, []))).toEqual([]);
  });
});

describe('merged blobs', () => {
  const blob = (w: number, h: number, fill = 0.3): Blob =>
    ({ color: 'red', pixels: 200, cx: 0, cy: 0, minX: 0, maxX: w - 1, minY: 0, maxY: h - 1, fillRatio: fill });

  it('tells one icon, two and three merged from how far they span', () => {
    expect(isMergedIcons(blob(30, 30), 30)).toBe(false);
    expect(isMergedIcons(blob(58, 32), 30)).toBe(true);
    expect(iconsInBlob(blob(58, 32), 30)).toBe(2);
    expect(iconsInBlob(blob(75, 40), 30)).toBe(3);
    expect(isMergedIcons(blob(100, 40), 30)).toBe(true); // a fight strung out
    expect(isMergedIcons(blob(200, 40), 30)).toBe(false); // longer than 5 icons: not icons
    // A fight piled up: short but heavy with ring.
    expect(iconsInBlob({ ...blob(60, 50), pixels: 1000 }, 30, 200)).toBe(5);
    expect(iconsInBlob({ ...blob(60, 50), pixels: 2000 }, 30, 200)).toBe(5);
    expect(isMergedIcons(blob(58, 32, 0.9), 30)).toBe(false); // filled: a structure, not rings
  });
});

describe('matchSets: Viego wears the icon of the champion he possesses', () => {
  const v = (n: number): Float32Array => new Float32Array([n]);
  // p5 is an enemy Viego; p1 and p2 are our teammates, p6 another enemy.
  const players: HearingPlayer[] = [
    { id: 'p1', side: 'ally', vecs: [v(1)] },
    { id: 'p2', side: 'ally', vecs: [v(2)] },
    { id: 'p5', side: 'enemy', vecs: [v(5)], possesses: true },
    { id: 'p6', side: 'enemy', vecs: [v(6)] },
  ];
  const vecsOf = (sets: ReturnType<typeof matchSets>, side: 'ally' | 'enemy', id: string): number[] =>
    (sets[side].find((s) => s.id === id)?.vecs ?? []).map((x) => x[0]);

  it('with nobody dead, everyone is matched against their own icons only', () => {
    const sets = matchSets(players, new Set());
    expect(vecsOf(sets, 'enemy', 'p5')).toEqual([5]);
    expect(vecsOf(sets, 'ally', 'p1')).toEqual([1]);
  });

  it("a dead teammate's face in a red ring is Viego", () => {
    const sets = matchSets(players, new Set(['p1']));
    expect(vecsOf(sets, 'enemy', 'p5')).toEqual([5, 1]);
    // Only Viego: the dead player's own set and his teammates' are untouched.
    expect(vecsOf(sets, 'enemy', 'p6')).toEqual([6]);
    expect(vecsOf(sets, 'ally', 'p1')).toEqual([1]);
  });

  it("never his own dead teammates, only the other team's", () => {
    expect(vecsOf(matchSets(players, new Set(['p6'])), 'enemy', 'p5')).toEqual([5]);
  });

  it('a dead Viego possesses nobody', () => {
    expect(vecsOf(matchSets(players, new Set(['p1', 'p5'])), 'enemy', 'p5')).toEqual([5]);
  });

  it('CameraHearing follows deaths and respawns', () => {
    const h = new CameraHearing(30);
    h.setPlayers(players);
    h.setDead(['p1', 'p2']);
    expect(vecsOf((h as any).setsBySide, 'enemy', 'p5')).toEqual([5, 1, 2]);
    h.setDead(['p2']);
    expect(vecsOf((h as any).setsBySide, 'enemy', 'p5')).toEqual([5, 2]);
    h.setDead([]);
    expect(vecsOf((h as any).setsBySide, 'enemy', 'p5')).toEqual([5]);
  });

  it('works the same for a Viego on our team', () => {
    const ours: HearingPlayer[] = [
      { id: 'p1', side: 'ally', vecs: [v(1)], possesses: true },
      { id: 'p5', side: 'enemy', vecs: [v(5)] },
    ];
    expect(vecsOf(matchSets(ours, new Set(['p5'])), 'ally', 'p1')).toEqual([1, 5]);
  });
});
