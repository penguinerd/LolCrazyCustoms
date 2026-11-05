import {
  BOX_HOLD_MS,
  FULL_SEARCH_EVERY_MS,
  CameraBoxTracker,
  expectedBoxSize,
  findCameraBox,
} from '../../src/services/camera-box';

// A 341 px minimap, as on the 2026-10-12 recordings (1080p, MinimapScale 1.92).
const W = 341;
const H = 341;
const { w: BW, h: BH } = expectedBoxSize(W);

function blank(): Uint8Array {
  return new Uint8Array(W * H);
}

function hLine(m: Uint8Array, y: number, xa: number, xb: number): void {
  if (y < 0 || y >= H) return;
  for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) m[y * W + x] = 1;
}

function vLine(m: Uint8Array, x: number, ya: number, yb: number): void {
  if (x < 0 || x >= W) return;
  for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y++) m[y * W + x] = 1;
}

/** The box League draws, top-left at (x0, y0), clipped to the minimap. */
function drawBox(m: Uint8Array, x0: number, y0: number, opts: { skip?: Array<'t' | 'b' | 'l' | 'r'> } = {}): void {
  const x1 = x0 + BW, y1 = y0 + BH;
  if (!opts.skip?.includes('t')) hLine(m, y0, x0, x1);
  if (!opts.skip?.includes('b')) hLine(m, y1, x0, x1);
  if (!opts.skip?.includes('l')) vLine(m, x0, y0, y1);
  if (!opts.skip?.includes('r')) vLine(m, x1, y0, y1);
}

/** Wipe a disc, as an icon drawn over the box edge does. */
function cover(m: Uint8Array, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - cx, y - cy) <= r) m[y * W + x] = 0;
  }
}

describe('expectedBoxSize', () => {
  it('is the 2026-10-12 recordings\' 85x47 on a 341 px minimap, and scales with it', () => {
    expect(expectedBoxSize(341)).toEqual({ w: 85, h: 47 });
    expect(expectedBoxSize(273)).toEqual({ w: 68, h: 38 });
  });
});

describe('findCameraBox', () => {
  it('finds a whole box', () => {
    const m = blank();
    drawBox(m, 120, 140);
    expect(findCameraBox(m, W, H, BW, BH)?.box).toEqual({ x0: 120, y0: 140, x1: 120 + BW, y1: 140 + BH });
  });

  it.each([
    // As far out as the camera goes: over a base, a 2026-10-12 recording's
    // box ran ~10 px off the minimap.
    ['top-left corner (camera over the blue base)', -20, -12],
    ['top-right corner (red base)', W - 70, -12],
    ['bottom-left', -20, H - 35],
    ['right edge', W - 30, 150],
    ['bottom edge', 100, H - 15],
  ])('finds a box clipped at the %s', (_name, x0, y0) => {
    const m = blank();
    drawBox(m, x0, y0);
    const found = findCameraBox(m, W, H, BW, BH);
    expect(found?.box).toEqual({ x0, y0, x1: x0 + BW, y1: y0 + BH });
  });

  it('finds a box with an edge missing and icons over the others', () => {
    const m = blank();
    drawBox(m, 200, 180, { skip: ['b'] });
    cover(m, 210, 180, 15);
    cover(m, 200 + BW, 200, 15);
    expect(findCameraBox(m, W, H, BW, BH)?.box).toEqual({ x0: 200, y0: 180, x1: 200 + BW, y1: 180 + BH });
  });

  it('finds the box when the movement path or a long straight line crosses it', () => {
    const m = blank();
    drawBox(m, 60, 60);
    hLine(m, 250, 20, 300); // a stray long line far away
    vLine(m, 90, 0, 340); // one crossing the box
    expect(findCameraBox(m, W, H, BW, BH)?.box).toEqual({ x0: 60, y0: 60, x1: 60 + BW, y1: 60 + BH });
  });

  it('does not make a box out of lone straight lines', () => {
    const m = blank();
    hLine(m, 100, 10, 330);
    hLine(m, 200, 10, 330);
    expect(findCameraBox(m, W, H, BW, BH)).toBeNull();
    const v = blank();
    vLine(v, 100, 10, 330);
    expect(findCameraBox(v, W, H, BW, BH)).toBeNull();
  });

  it('finds nothing on an empty minimap (the loading screen)', () => {
    expect(findCameraBox(blank(), W, H, BW, BH)).toBeNull();
  });

  it('with `near`, looks only around it', () => {
    const m = blank();
    drawBox(m, 40, 40);
    expect(findCameraBox(m, W, H, BW, BH, { x0: 200, y0: 200 })).toBeNull();
    expect(findCameraBox(m, W, H, BW, BH, { x0: 45, y0: 35 })?.box.x0).toBe(40);
  });

  it('refuses bad input instead of throwing', () => {
    expect(findCameraBox(new Uint8Array(10), W, H, BW, BH)).toBeNull();
    expect(findCameraBox(blank(), 0, 0, BW, BH)).toBeNull();
  });
});

describe('CameraBoxTracker', () => {
  it('follows a box that drags, and one that jumps (a click on the minimap)', () => {
    const t = new CameraBoxTracker();
    let m = blank();
    drawBox(m, 100, 100);
    expect(t.update(m, W, H, 0)?.x0).toBe(100);
    m = blank();
    drawBox(m, 106, 103);
    expect(t.update(m, W, H, 33)?.x0).toBe(106);
    m = blank();
    drawBox(m, 20, 250);
    // The whole-minimap search runs at most every FULL_SEARCH_EVERY_MS: the
    // old box is held until then.
    expect(t.update(m, W, H, 66)?.x0).toBe(106);
    expect(t.update(m, W, H, 33 + FULL_SEARCH_EVERY_MS)).toEqual({ x0: 20, y0: 250, x1: 20 + BW, y1: 250 + BH });
  });

  it('holds the last box for BOX_HOLD_MS when none is readable, then lets go', () => {
    const t = new CameraBoxTracker();
    const m = blank();
    drawBox(m, 150, 150);
    t.update(m, W, H, 1000);
    expect(t.update(blank(), W, H, 1000 + BOX_HOLD_MS)?.x0).toBe(150);
    expect(t.update(blank(), W, H, 1000 + BOX_HOLD_MS + 1)).toBeNull();
  });

  it('does not let stray lines near the old box hold it after a jump', () => {
    const t = new CameraBoxTracker();
    let m = blank();
    drawBox(m, 100, 100);
    t.update(m, W, H, 0);
    // The box jumped; only half an old edge's worth of white is left near it.
    m = blank();
    hLine(m, 100, 100, 140);
    vLine(m, 100, 100, 120);
    drawBox(m, 230, 40);
    expect(t.update(m, W, H, FULL_SEARCH_EVERY_MS)?.x0).toBe(230);
  });

  it('learns a box size other than the expected one from whole boxes', () => {
    const t = new CameraBoxTracker();
    for (let i = 0; i < 5; i++) t.noteWholeBox({ x0: 0, y0: 0, x1: 90, y1: 50 });
    const m = blank();
    // 90x50 drawn, 3 edges only: found only by a tracker that knows the size.
    hLine(m, 60, 60, 150);
    vLine(m, 60, 60, 110);
    vLine(m, 150, 60, 110);
    expect(t.update(m, W, H, 0)).toEqual({ x0: 60, y0: 60, x1: 150, y1: 110 });
  });

  it('learns an ultrawide (21:9) box, a third wider than 16:9\'s', () => {
    const t = new CameraBoxTracker();
    for (let i = 0; i < 5; i++) t.noteWholeBox({ x0: 0, y0: 0, x1: 113, y1: 47 });
    const m = blank();
    hLine(m, 60, 60, 173);
    vLine(m, 60, 60, 107);
    vLine(m, 173, 60, 107);
    expect(t.update(m, W, H, 0)).toEqual({ x0: 60, y0: 60, x1: 173, y1: 107 });
  });

  it('ignores a learnt size far from the expected one', () => {
    const t = new CameraBoxTracker();
    for (let i = 0; i < 5; i++) t.noteWholeBox({ x0: 0, y0: 0, x1: 200, y1: 30 });
    const m = blank();
    drawBox(m, 70, 70);
    expect(t.update(m, W, H, 0)?.x1).toBe(70 + BW);
  });
});
