// Whose minimap icon is this? For camera mode, which hears the players whose
// icons are inside the camera rectangle and needs to know who each icon is.
//
// The question is small: one of at most five players, the ones on the team
// whose colour the ring is, and the game says which champion each plays. The
// minimap draws every champion's BASE icon whatever skin they have on (the
// 2026-10-12 recordings: Soraka skin 16, Syndra skin 54 and Volibear skin 29
// were all drawn with their base icons), so each player is compared with the
// base icon of their champion (and of each form it takes).
//
// The comparison is skin-matcher.ts's correlation; what differs is how hard it
// looks. A blob's centre is the centre of the ring pixels the colour filter
// kept, which another icon on top pulls a few pixels off, and the icon's scale
// on screen varies with MinimapScale. matchIcon's search (±2 px, three scales)
// is tuned for the self tracker's ~30 Hz; on those recordings it left 44% of
// own-team icons and 79% of enemy icons unnamed. Searching ±4 px and four
// scales named 76% and 41% of them, and every named icon checked by eye was
// right. A coarse pass every other pixel, then a pixel either way around each
// player's best, gets nearly all of that for a quarter of the work.

import type { CaptureFrame } from '../core/capture-frame';
import type { Blob } from './blob-types';
import { decideMatch, innerIndices, MatchScore, MATCH_SIZE, TemplateSet } from './skin-matcher';

/** Crop sides tried, as a fraction of the expected icon diameter. */
const SCALES = [0.9, 1.0, 1.1, 1.2];
/** Centre offsets (px) of the coarse pass; the fine pass adds ±1 around the best. */
const COARSE_SHIFTS = [-4, -2, 0, 2, 4];
const SCALE_STEP = 0.05;
/** Crop sides tried at each grid spot inside a merged blob. One alone (1.05)
 *  named a fifth fewer of a simulated teamfight's icons. */
const BLOB_SCALES = [1.0, 1.1];
/** How many of the best coarse matches the fine pass refines. */
const REFINED = 3;

// ---- Coarse passes at half resolution ----
//
// Where an icon is, and which few players it could be, is found comparing a
// quarter of the pixels (every other row and column of the compared circle);
// only those few are then compared at full resolution, and only full-resolution
// scores are ever returned. Same answers on the simulated games, for well
// under half the work.

let halfCache: Int32Array | null = null;
/** Positions in innerIndices() of the pixels on even rows and columns. */
function halfPositions(): Int32Array {
  if (halfCache) return halfCache;
  const idx = innerIndices();
  const out: number[] = [];
  for (let n = 0; n < idx.length; n++) {
    const i = idx[n] % MATCH_SIZE;
    const j = (idx[n] - i) / MATCH_SIZE;
    if (i % 2 === 0 && j % 2 === 0) out.push(n);
  }
  halfCache = Int32Array.from(out);
  return halfCache;
}

const halfTemplates = new WeakMap<Float32Array, Float32Array>();
/** A template cut down to the half-resolution pixels, re-normalised. */
function halfOf(t: Float32Array): Float32Array {
  let h = halfTemplates.get(t);
  if (h) return h;
  const pos = halfPositions();
  h = new Float32Array(pos.length * 3);
  for (let k = 0; k < pos.length; k++) for (let c = 0; c < 3; c++) h[k * 3 + c] = t[pos[k] * 3 + c];
  normalize(h);
  halfTemplates.set(t, h);
  return h;
}

function normalize(v: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i];
  const mean = sum / v.length;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= mean;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * normalizedInner(sampleSquare(...)) of skin-matcher.ts, computed only for the
 * pixels inside the compared circle: the same numbers for 40% of the work,
 * which is most of what identification costs. Out-of-frame pixels read as 0,
 * as sampleSquare's default fill.
 */
export function innerVector(frame: CaptureFrame, cx: number, cy: number, side: number): Float32Array {
  return sampleInner(frame, cx, cy, side, null);
}

/** innerVector over all of the compared circle, or only at `positions` (of
 *  innerIndices()), normalised either way. */
function sampleInner(frame: CaptureFrame, cx: number, cy: number, side: number, positions: Int32Array | null): Float32Array {
  const S = MATCH_SIZE;
  const idx = innerIndices();
  const { data, width, height } = frame;
  const count = positions ? positions.length : idx.length;
  const v = new Float32Array(count * 3);
  const step = side / S;
  const x0 = cx - side / 2;
  const y0 = cy - side / 2;
  for (let m = 0; m < count; m++) {
    const n = positions ? positions[m] : m;
    const i = idx[n] % S;
    const j = (idx[n] - i) / S;
    const sx = x0 + (i + 0.5) * step - 0.5;
    const sy = y0 + (j + 0.5) * step - 0.5;
    const xA = Math.floor(sx), yA = Math.floor(sy);
    const fx = sx - xA, fy = sy - yA;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const in0 = yA >= 0 && yA < height, in1 = yA + 1 >= 0 && yA + 1 < height;
    const inA = xA >= 0 && xA < width, inB = xA + 1 >= 0 && xA + 1 < width;
    const p00 = in0 && inA ? (yA * width + xA) * 4 : -1;
    const p10 = in0 && inB ? (yA * width + xA + 1) * 4 : -1;
    const p01 = in1 && inA ? ((yA + 1) * width + xA) * 4 : -1;
    const p11 = in1 && inB ? ((yA + 1) * width + xA + 1) * 4 : -1;
    for (let c = 0; c < 3; c++) {
      v[m * 3 + c] = (p00 < 0 ? 0 : data[p00 + c]) * w00 + (p10 < 0 ? 0 : data[p10 + c]) * w10 +
        (p01 < 0 ? 0 : data[p01 + c]) * w01 + (p11 < 0 ? 0 : data[p11 + c]) * w11;
    }
  }
  normalize(v);
  return v;
}

/** Every player's best correlation with one crop, at full or half resolution. */
function scoreCrop(frame: CaptureFrame, x: number, y: number, side: number, sets: TemplateSet[], half = false): number[] {
  const v = sampleInner(frame, x, y, side, half ? halfPositions() : null);
  return sets.map((set) => {
    let best = -Infinity;
    for (const t of set.vecs) {
      const s = dot(v, half ? halfOf(t) : t);
      if (s > best) best = s;
    }
    return best;
  });
}

/**
 * Each player's best correlation with the icon near (cx, cy), highest first.
 * `sets`: the players the icon can belong to (the team its ring colour says).
 */
export function identifyIcon(
  frame: CaptureFrame,
  cx: number,
  cy: number,
  iconDiam: number,
  sets: TemplateSet[],
): MatchScore[] {
  if (sets.length === 0) return [];
  // Coarse, at half resolution: where each player fits best.
  const coarse = sets.map(() => -Infinity);
  const where = sets.map(() => ({ dx: 0, dy: 0, k: 1 }));
  for (const k of SCALES) {
    for (const dy of COARSE_SHIFTS) {
      for (const dx of COARSE_SHIFTS) {
        scoreCrop(frame, cx + dx, cy + dy, iconDiam * k, sets, true).forEach((s, i) => {
          if (s > coarse[i]) { coarse[i] = s; where[i] = { dx, dy, k }; }
        });
      }
    }
  }
  // Full resolution from here: every player at their own best spot...
  const best = sets.map(() => -Infinity);
  const tried = new Set<string>();
  const tryAt = (dx: number, dy: number, k: number): void => {
    const key = dx + ',' + dy + ',' + k.toFixed(2);
    if (tried.has(key)) return;
    tried.add(key);
    scoreCrop(frame, cx + dx, cy + dy, iconDiam * k, sets).forEach((s, i) => {
      if (s > best[i]) best[i] = s;
    });
  };
  for (const w of where) tryAt(w.dx, w.dy, w.k);
  // ...and a pixel and a scale step either way around the three best: the
  // winner and whoever could still turn out to be its runner-up, which is all
  // decideMatch looks at.
  const seeds = where
    .map((w, i) => ({ ...w, s: coarse[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, REFINED);
  for (const { dx, dy, k } of seeds) {
    for (const kk of [k - SCALE_STEP, k, k + SCALE_STEP]) {
      for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) tryAt(dx + ddx, dy + ddy, kk);
    }
  }
  return sets.map((set, i) => ({ id: set.id, score: best[i] })).sort((a, b) => b.score - a.score);
}

export interface NamedIcon { id: string; x: number; y: number; score: number }

/**
 * The players recognisable inside a blob of several icons merged together
 * (two to three across; a teamfight). Every position on a grid over the blob
 * is scored against every player; a player is named where they score best,
 * if that is a clear match (decideMatch's thresholds, against the other
 * players at that same spot) and not on top of someone named more clearly.
 * At most `maxIcons`, the number of icons the blob holds.
 */
export function identifyInBlob(
  frame: CaptureFrame,
  blob: Blob,
  iconDiam: number,
  sets: TemplateSet[],
  maxIcons: number,
): NamedIcon[] {
  if (sets.length === 0 || maxIcons <= 0) return [];
  const inset = iconDiam * 0.35;
  const x0 = blob.minX + inset, x1 = blob.maxX - inset;
  const y0 = blob.minY + inset, y1 = blob.maxY - inset;
  // A whole fight in one blob is several times the area: a coarser grid
  // keeps it to a few tens of milliseconds.
  const STEP = Math.max(blob.maxX - blob.minX, blob.maxY - blob.minY) > iconDiam * 2.6 ? 3 : 2;
  // Coarse, at half resolution: where in the blob each player fits best.
  const spot = sets.map(() => ({ score: -Infinity, x: 0, y: 0, k: 1 }));
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += STEP) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += STEP) {
      for (const k of BLOB_SCALES) {
        scoreCrop(frame, x, y, iconDiam * k, sets, true).forEach((s, i) => {
          if (s > spot[i].score) spot[i] = { score: s, x, y, k };
        });
      }
    }
  }
  // Full resolution around the spots of the players who could be in it (two
  // more than it holds): there each is scored against everyone, for the margin.
  const per = sets.map(() => ({ score: -Infinity, x: 0, y: 0, ranked: [] as MatchScore[] }));
  const candidates = spot.map((sp, i) => ({ ...sp, i })).sort((a, b) => b.score - a.score).slice(0, maxIcons + 2);
  for (const c of candidates) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const scores = scoreCrop(frame, c.x + dx, c.y + dy, iconDiam * c.k, sets);
        if (scores[c.i] > per[c.i].score) {
          per[c.i] = {
            score: scores[c.i], x: c.x + dx, y: c.y + dy,
            ranked: sets.map((set, j) => ({ id: set.id, score: scores[j] })).sort((a, b) => b.score - a.score),
          };
        }
      }
    }
  }
  const named: NamedIcon[] = [];
  const order = per.map((p, i) => ({ ...p, id: sets[i].id })).sort((a, b) => b.score - a.score);
  for (const p of order) {
    if (named.length >= maxIcons) break;
    if (decideMatch(p.ranked) !== p.id) continue;
    if (named.some((n) => Math.hypot(n.x - p.x, n.y - p.y) < iconDiam * 0.4)) continue;
    named.push({ id: p.id, x: p.x, y: p.y, score: p.score });
  }
  return named;
}
