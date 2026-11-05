// The camera rectangle on the minimap, found as a rectangle of KNOWN SIZE.
//
// League's camera zoom is fixed, so the white box the minimap draws around
// what is on screen has the same size all game (85x47 px on a 341 px
// minimap at 1920x1080; real recordings of 2026-10-12 never strayed more than
// 2 px). describeViewportCenter needs two opposing edges of comparable length
// on both axes, and on those recordings it read the box on barely half of the
// in-game snapshots: icons sit on its edges, the box is clipped where the
// camera is over a base, and the movement path crosses it. Knowing the size,
// two or three edges — even a corner — pin it down.
//
// The search: every placement of the rectangle (partly off the minimap
// allowed, as League clips it) is scored by the share of its visible
// perimeter that lies on white straight-run pixels (the viewport mask
// tracking.ts builds), with a pixel of slack either way. Prefix sums make each
// placement four lookups per edge, so the whole search is a few hundred
// thousand lookups for a 341 px minimap.

export interface CameraBox { x0: number; y0: number; x1: number; y1: number }

export interface CameraBoxResult {
  box: CameraBox;
  /** Share of the visible perimeter on white (0..1). */
  score: number;
  /** Visible perimeter in px: low when the box is mostly off the minimap. */
  visible: number;
}

/** Below this share of its visible perimeter on white, a placement is not the box. */
export const BOX_MIN_SCORE = 0.4;
/** At least this much of the perimeter has to be on the minimap to judge it:
 *  a quarter is a box with its corner over a base. */
export const BOX_MIN_VISIBLE_FRACTION = 0.25;
/** The box's size as a share of the minimap's side, measured on 2026-10-12
 *  recordings (1920x1080, MinimapScale 1.92): 85/341 by 47/341. A 16:9 screen
 *  draws the same proportions at any resolution and minimap scale. */
export const BOX_WIDTH_FRACTION = 85 / 341;
export const BOX_HEIGHT_FRACTION = 47 / 341;

/** Expected box size (px) for a minimap `side` px across. */
export function expectedBoxSize(side: number): { w: number; h: number } {
  return { w: Math.round(side * BOX_WIDTH_FRACTION), h: Math.round(side * BOX_HEIGHT_FRACTION) };
}

/**
 * Row-wise and column-wise prefix sums of `mask`, each pixel counting 2 when
 * marked and 1 when only a neighbour across the edge direction is: an edge
 * drawn a pixel off still counts, but the exact placement wins a tie.
 */
function prefixSums(mask: Uint8Array, w: number, h: number): { rows: Int32Array; cols: Int32Array } {
  // rows[y * (w + 1) + x]: weighted marks in row y before column x.
  const rows = new Int32Array(h * (w + 1));
  const cols = new Int32Array(w * (h + 1));
  const at = (x: number, y: number): number => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += at(x, y) ? 2 : at(x, y - 1) || at(x, y + 1) ? 1 : 0;
      rows[y * (w + 1) + x + 1] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      s += at(x, y) ? 2 : at(x - 1, y) || at(x + 1, y) ? 1 : 0;
      cols[x * (h + 1) + y + 1] = s;
    }
  }
  return { rows, cols };
}

/**
 * The best placement of a `bw` x `bh` rectangle on `viewportMask` (`w` x `h`,
 * 1 = white pixel in a long straight run), or null when none is convincing.
 * The box may run off any side of the minimap; only its visible part counts.
 * With `near`, only placements whose top-left corner is within `radius` px of
 * it are tried: the box drags smoothly, so last frame's position is a cheap
 * place to look first (CameraBoxTracker).
 */
export function findCameraBox(
  viewportMask: Uint8Array,
  w: number,
  h: number,
  bw: number,
  bh: number,
  near?: { x0: number; y0: number },
  radius = 12,
): CameraBoxResult | null {
  if (w <= 0 || h <= 0 || bw < 4 || bh < 4 || viewportMask.length < w * h) return null;
  const { rows, cols } = prefixSums(viewportMask, w, h);
  const hRun = (y: number, xa: number, xb: number): [number, number] => {
    // Marked pixels and length of row y between columns xa..xb (inclusive), clipped.
    if (y < 0 || y >= h) return [0, 0];
    const a = Math.max(0, xa), b = Math.min(w - 1, xb);
    if (b < a) return [0, 0];
    return [(rows[y * (w + 1) + b + 1] - rows[y * (w + 1) + a]) / 2, b - a + 1];
  };
  const vRun = (x: number, ya: number, yb: number): [number, number] => {
    if (x < 0 || x >= w) return [0, 0];
    const a = Math.max(0, ya), b = Math.min(h - 1, yb);
    if (b < a) return [0, 0];
    return [(cols[x * (h + 1) + b + 1] - cols[x * (h + 1) + a]) / 2, b - a + 1];
  };
  const perimeter = 2 * (bw + bh);
  let best: CameraBoxResult | null = null;
  const yLo = near ? Math.max(-bh + 2, near.y0 - radius) : -bh + 2;
  const yHi = near ? Math.min(h - 2, near.y0 + radius) : h - 2;
  const xLo = near ? Math.max(-bw + 2, near.x0 - radius) : -bw + 2;
  const xHi = near ? Math.min(w - 2, near.x0 + radius) : w - 2;
  for (let y0 = yLo; y0 <= yHi; y0++) {
    const y1 = y0 + bh;
    for (let x0 = xLo; x0 <= xHi; x0++) {
      const x1 = x0 + bw;
      const [tHit, tLen] = hRun(y0, x0, x1);
      const [bHit, bLen] = hRun(y1, x0, x1);
      const [lHit, lLen] = vRun(x0, y0 + 1, y1 - 1);
      const [rHit, rLen] = vRun(x1, y0 + 1, y1 - 1);
      const visible = tLen + bLen + lLen + rLen;
      if (visible < perimeter * BOX_MIN_VISIBLE_FRACTION) continue;
      // Both a horizontal and a vertical edge have to show: a lone straight
      // line (a lane edge, the path) is not a rectangle.
      if (tHit + bHit < bw * 0.3 || lHit + rHit < bh * 0.3) continue;
      const score = (tHit + bHit + lHit + rHit) / visible;
      if (!best || score > best.score || (score === best.score && visible > best.visible)) {
        best = { box: { x0, y0, x1, y1 }, score, visible };
      }
    }
  }
  return best && best.score >= BOX_MIN_SCORE ? best : null;
}

/** How long the last box found stands in for one that cannot be read (a ping
 *  over its edge, a frame mid-drag), before the camera counts as unknown. */
export const BOX_HOLD_MS = 1000;
/** The search near the last box is taken without a full search at or above this. */
const LOCAL_MIN_SCORE = 0.6;
/** How often the whole-minimap search may run when the local one fails. */
export const FULL_SEARCH_EVERY_MS = 100;

/**
 * The camera box frame to frame: looked for near where it was first, over the
 * whole minimap when that fails, and held for BOX_HOLD_MS when neither finds
 * it. Its size is the expected one (expectedBoxSize) until boxes have been
 * found: then the size those had, which absorbs a screen that is not 16:9.
 */
export class CameraBoxTracker {
  private last: CameraBox | null = null;
  private lastMs = -Infinity;
  private sizes: Array<{ w: number; h: number }> = [];
  private learnt: { w: number; h: number } | null = null;
  private lastFullMs = -Infinity;

  update(viewportMask: Uint8Array, w: number, h: number, nowMs: number): CameraBox | null {
    const size = this.size(w);
    // Near the last box first, believed only when clearly a box: a weak match
    // there may be stray lines left behind by a box that jumped (a click on
    // the minimap), which the full search would find elsewhere.
    const local = this.last ? findCameraBox(viewportMask, w, h, size.w, size.h, this.last) : null;
    let found = local && local.score >= LOCAL_MIN_SCORE ? local : null;
    // The full search costs ~10 ms: at most every FULL_SEARCH_EVERY_MS, so a
    // box that stays unreadable (a ping on it, the shop open) does not cost
    // that on every frame.
    if (!found && nowMs - this.lastFullMs >= FULL_SEARCH_EVERY_MS) {
      this.lastFullMs = nowMs;
      found = findCameraBox(viewportMask, w, h, size.w, size.h);
    }
    if (found) {
      this.last = found.box;
      this.lastMs = nowMs;
      return found.box;
    }
    return nowMs - this.lastMs <= BOX_HOLD_MS ? this.last : null;
  }

  /** The last box found, however old, and when. */
  lastSeen(): { box: CameraBox; atMs: number } | null {
    return this.last ? { box: this.last, atMs: this.lastMs } : null;
  }

  /** Teach the size from a box the edge-pair reader (describeViewportCenter)
   *  found whole: the median of the last 15 such. */
  noteWholeBox(box: CameraBox): void {
    this.sizes.push({ w: box.x1 - box.x0, h: box.y1 - box.y0 });
    if (this.sizes.length > 15) this.sizes.shift();
    if (this.sizes.length >= 5) {
      const med = (a: number[]): number => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
      this.learnt = { w: med(this.sizes.map((s) => s.w)), h: med(this.sizes.map((s) => s.h)) };
    }
  }

  private size(side: number): { w: number; h: number } {
    const expected = expectedBoxSize(side);
    // A learnt size far from the expected one is two unrelated lines the
    // edge-pair reader paired up, not a different screen shape.
    // 21:9 makes it a third wider than 16:9 does, so up to half either way.
    if (this.learnt && Math.abs(this.learnt.w - expected.w) <= expected.w * 0.5 &&
      Math.abs(this.learnt.h - expected.h) <= expected.h * 0.5) return this.learnt;
    return expected;
  }

  reset(): void {
    this.last = null;
    this.lastMs = -Infinity;
    this.lastFullMs = -Infinity;
  }
}
