// Offline measurement for "camera mode": over the minimap snapshots of real
// debug bundles, how often is the camera rectangle readable, and how often is
// each champion icon named — and named right — by matching it against the
// exact icons of the players on its team?
//
// Not part of the normal suite: it reads local, private recordings. Run with
//   CAMERA_EVAL=<bundles dir> npx jest tests/cv/camera-eval
// <bundles dir> holds unzipped bundles plus an `eval.json` describing them
// (see EvalSpec) and `_icons/<alias>/` with each champion's HUD listing
// (`_listing.html`) and circle icons. Writes `eval-out/` there: a CSV of every
// icon and contact sheets (crop | the icon it was matched to) to check by eye.

import * as fs from 'fs';
import * as path from 'path';
import { decodePng, encodePng, RgbaImage } from './harness/png';
import { iconFilesForSkin, iconTemplates, matchIcon, decideMatch, MatchScore, TemplateSet, normalizedInner, sampleSquare } from '../../src/services/skin-matcher';
import { describeViewportCenter, filledIconRing } from '../../src/services/tracking-helpers';
import { expectedBoxSize, findCameraBox, CameraBox } from '../../src/services/camera-box';
import { identifyIcon, identifyInBlob } from '../../src/services/icon-identity';
import { classifyIconBlobs } from '../../src/services/camera-hearing';
import type { Blob } from '../../src/services/blob-types';
import type { CaptureFrame } from '../../src/core/capture-frame';

interface PlayerSpec { alias: string; skin: number | null }
interface BundleSpec { dir: string; pov: string; team: string }
interface GameSpec { teams: Record<string, Record<string, PlayerSpec>>; bundles: BundleSpec[] }
interface EvalSpec { iconDiam: number; games: GameSpec[] }

const ROOT = process.env.CAMERA_EVAL;
const run = ROOT ? describe : describe.skip;

// ---- the tracker's pixel pipeline, mirrored (TrackingService keeps it private) ----

function classifyPixel(r: number, g: number, b: number): 0 | 1 | 2 {
  if (r < 100 && g > 120 && b > 120 && (g + b) > 280) return 1;
  if (r > 140 && g < 100 && b < 100) return 2;
  return 0;
}

function masks(img: RgbaImage): { mask: Uint8Array; viewport: Uint8Array } {
  const { width: w, height: h, data } = img;
  const raw = new Uint8Array(w * h);
  const white = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    raw[i] = classifyPixel(r, g, b);
    if (r > 200 && g > 200 && b > 200) white[i] = 1;
  }
  const mask = new Uint8Array(raw);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      mask[i] = raw[i - w] || raw[i + w] || raw[i - 1] || raw[i + 1];
    }
  }
  const viewport = new Uint8Array(w * h);
  const RUN = 12;
  for (let y = 0; y < h; y++) {
    let s = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && white[y * w + x] === 1;
      if (on && s < 0) s = x;
      else if (!on && s >= 0) { if (x - s >= RUN) for (let k = s; k < x; k++) viewport[y * w + k] = 1; s = -1; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && white[y * w + x] === 1;
      if (on && s < 0) s = y;
      else if (!on && s >= 0) { if (y - s >= RUN) for (let k = s; k < y; k++) viewport[k * w + x] = 1; s = -1; }
    }
  }
  return { mask, viewport };
}

function findBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i0 = y * w + x;
      if (seen[i0] || !mask[i0]) continue;
      const v = mask[i0];
      const stack = [x, y];
      let sx = 0, sy = 0, n = 0, minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const cy = stack.pop()!, cx = stack.pop()!;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        const i = cy * w + cx;
        if (seen[i] || mask[i] !== v) continue;
        seen[i] = 1; sx += cx; sy += cy; n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        stack.push(cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1);
      }
      if (n >= 10) {
        out.push({ color: v === 1 ? 'teal' : 'red', pixels: n, cx: Math.round(sx / n), cy: Math.round(sy / n),
          minX, maxX, minY, maxY, fillRatio: n / ((maxX - minX + 1) * (maxY - minY + 1)) });
      }
    }
  }
  return out;
}

type Kind = 'single' | 'merged' | null;

/** filterIconBlobs for a single icon, either colour; a red blob up to 2.6
 *  icons across (isPossibleEnemyIcon) that is not one icon is 'merged'. */
function iconKind(b: Blob, mask: Uint8Array, w: number, h: number, diam: number): Kind {
  const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
  const single = bw >= diam * 0.6 && bw <= diam * 1.6 && bh >= diam * 0.6 && bh <= diam * 1.6 &&
    bw / bh >= 0.6 && bw / bh <= 1.7 && b.pixels >= 15 && b.fillRatio >= 0.08;
  if (single && (b.fillRatio <= 0.40 || filledIconRing(b, mask, w, h))) return 'single';
  if (b.pixels >= 15 && b.fillRatio <= 0.55 && b.fillRatio >= 0.08 &&
    bw >= diam * 0.6 && bh >= diam * 0.6 && bw <= diam * 2.6 && bh <= diam * 2.6) return 'merged';
  return null;
}

// ---- a wider search than matchIcon's, to see what centring and scale cost ----

const MODE = process.env.EVAL_MATCH ?? 'app';

function wideMatch(frame: CaptureFrame, cx: number, cy: number, diam: number, sets: TemplateSet[]): MatchScore[] {
  const best = sets.map(() => -Infinity);
  for (let k = 0.85; k <= 1.31; k += 0.05) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const v = normalizedInner(sampleSquare(frame.data, frame.width, frame.height, cx + dx, cy + dy, diam * k));
        sets.forEach((set, si) => {
          for (const t of set.vecs) {
            let d = 0;
            for (let i = 0; i < v.length; i++) d += v[i] * t[i];
            if (d > best[si]) best[si] = d;
          }
        });
      }
    }
  }
  return sets.map((set, si) => ({ id: set.id, score: best[si] })).sort((a, b) => b.score - a.score);
}

// ---- templates ----

function loadSets(iconsDir: string, team: Record<string, PlayerSpec>): { sets: TemplateSet[]; art: Map<string, RgbaImage> } {
  const sets: TemplateSet[] = [];
  const art = new Map<string, RgbaImage>();
  for (const [id, p] of Object.entries(team)) {
    const dir = path.join(iconsDir, p.alias);
    const listing = fs.readFileSync(path.join(dir, '_listing.html'), 'utf8');
    const files = p.skin === null
      ? fs.readdirSync(dir).filter(f => f.endsWith('.png'))
      : iconFilesForSkin(listing, p.alias, p.skin);
    const vecs: Float32Array[] = [];
    for (const f of files) {
      const img = decodePng(fs.readFileSync(path.join(dir, f)));
      vecs.push(...iconTemplates(img.data, img.width, img.height));
      if (!art.has(id)) art.set(id, img);
    }
    sets.push({ id, vecs });
  }
  return { sets, art };
}

// ---- contact sheets ----

/** A copy of `img` with `box` drawn on it in green. */
function drawBox(img: RgbaImage, box: CameraBox): RgbaImage {
  const out: RgbaImage = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const put = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    out.data[o] = 0; out.data[o + 1] = 255; out.data[o + 2] = 0;
  };
  for (let x = box.x0; x <= box.x1; x++) { put(x, box.y0 - 2); put(x, box.y1 + 2); }
  for (let y = box.y0; y <= box.y1; y++) { put(box.x0 - 2, y); put(box.x1 + 2, y); }
  return out;
}

/** Snapshots side by side, `cols` across. */
function mosaic(imgs: RgbaImage[], cols: number): RgbaImage {
  const cw = imgs[0].width, ch = imgs[0].height;
  const rowsN = Math.ceil(imgs.length / cols);
  const out: RgbaImage = { data: new Uint8ClampedArray(cols * cw * rowsN * ch * 4), width: cols * cw, height: rowsN * ch };
  imgs.forEach((im, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) out.data.set(im.data.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * out.width + ox) * 4);
  });
  return out;
}

const CELL = 64;

function blit(dst: RgbaImage, dx: number, dy: number, src: RgbaImage, sx: number, sy: number, sw: number, sh: number, size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.floor(sx + (x * sw) / size), py = Math.floor(sy + (y * sh) / size);
      const o = ((dy + y) * dst.width + dx + x) * 4;
      if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
      const i = (py * src.width + px) * 4;
      const a = src.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) dst.data[o + c] = src.data[i + c] * a + 30 * (1 - a);
      dst.data[o + 3] = 255;
    }
  }
}

interface Row {
  idx: number; cell: number; bundle: string; snap: string; colour: string; kind: string; x: number; y: number;
  inBox: boolean; ranked: MatchScore[]; decided: string | null;
}

run('camera mode — offline measurement on real bundles', () => {
  test('names icons and reads the camera box', () => {
    const root = ROOT!;
    const spec: EvalSpec = JSON.parse(fs.readFileSync(path.join(root, 'eval.json'), 'utf8'));
    const outDir = path.join(root, 'eval-out');
    fs.mkdirSync(outDir, { recursive: true });
    const diam = spec.iconDiam;
    const rows: Row[] = [];
    const sheetCells: Array<{ crop: RgbaImage; cx: number; cy: number; art: RgbaImage | null; decided: boolean }> = [];
    let snaps = 0, boxes = 0;
    const miss: Record<string, number> = {};
    let mergedTeal = 0, mergedRed = 0, mergedIcons = 0, mergedNamed = 0, matchMs = 0, matched = 0, looseSeen = 0, looseNamed = 0;
    const mergedCells: number[] = [];
    const boxCsv = ['bundle,snap,found,old,score,box'];
    const spanHist: Record<number, number> = {};
    const spanRows: string[] = ['bundle,snap,colour,x,y,span,pixels,fill'];
    let loading = 0, loadingBoxes = 0, oldBoxes = 0, disagree = 0;
    const boxShots: Array<{ img: RgbaImage; found: boolean }> = [];

    for (const game of spec.games) {
      const byTeam = new Map(Object.entries(game.teams).map(([t, players]) => [t, loadSets(path.join(root, '_icons'), players)]));
      for (const b of game.bundles) {
        const other = Object.keys(game.teams).find(t => t !== b.team)!;
        const snapDir = path.join(root, b.dir, 'minimap');
        for (const snap of fs.readdirSync(snapDir).filter(f => f.endsWith('.png')).sort()) {
          const img = decodePng(fs.readFileSync(path.join(snapDir, snap)));
          const { mask, viewport } = masks(img);
          const blobs = findBlobs(mask, img.width, img.height);
          // The loading screen (no minimap yet): our own icon is always drawn
          // on our own minimap, so a frame without one teal icon is not a game.
          if (!blobs.some(bl => bl.color === 'teal' && iconKind(bl, mask, img.width, img.height, diam))) {
            loading++;
            const sz = expectedBoxSize(img.width);
            if (findCameraBox(viewport, img.width, img.height, sz.w, sz.h)) loadingBoxes++;
            continue;
          }
          snaps++;
          const old = describeViewportCenter(viewport, img.width, img.height);
          if (old.box) oldBoxes++;
          const size = expectedBoxSize(img.width);
          const found = findCameraBox(viewport, img.width, img.height, size.w, size.h);
          const vp = { box: found?.box };
          if (vp.box) boxes++; else miss[old.miss ?? '?'] = (miss[old.miss ?? '?'] ?? 0) + 1;
          if (old.box && found) {
            const d = Math.max(Math.abs(old.box.x0 - found.box.x0), Math.abs(old.box.y0 - found.box.y0),
              Math.abs(old.box.x1 - found.box.x1), Math.abs(old.box.y1 - found.box.y1));
            if (d > 3) disagree++;
          }
          boxCsv.push([b.dir, snap, found ? 'box' : 'none', old.box ? 'old' : old.miss, found ? found.score.toFixed(2) : '',
            found ? [found.box.x0, found.box.y0, found.box.x1, found.box.y1].join(' ') : ''].join(','));
          boxShots.push({ img: found ? drawBox(img, found.box) : img, found: !!found });
          const frame: CaptureFrame = { data: img.data, width: img.width, height: img.height } as CaptureFrame;
          // The app's own split (camera-hearing.ts): one icon each, the
          // tracker's strict ones and the looser ones believed only when
          // recognised, and blobs of several.
          const strictSingles = blobs.filter(bl => iconKind(bl, mask, img.width, img.height, diam) === 'single');
          const alone = strictSingles.filter(bl => Math.max(bl.maxX - bl.minX + 1, bl.maxY - bl.minY + 1) <= diam * 1.15)
            .map(bl => bl.pixels).sort((x, y) => x - y);
          const ringPx = alone.length ? alone[Math.floor(alone.length / 2)] : diam * 10;
          const { lone, merged } = classifyIconBlobs(blobs, strictSingles, diam, ringPx);
          for (const bl of strictSingles) {
            const sp = Math.max(bl.maxX - bl.minX + 1, bl.maxY - bl.minY + 1) / diam;
            spanHist[Math.min(20, Math.floor(sp * 10))] = (spanHist[Math.min(20, Math.floor(sp * 10))] ?? 0) + 1;
            spanRows.push([b.dir, snap, bl.color, bl.cx, bl.cy, sp.toFixed(2), bl.pixels, bl.fillRatio.toFixed(2)].join(','));
          }
          for (const { b: blob, n } of merged) {
            const team = blob.color === 'teal' ? b.team : other;
            const { sets, art } = byTeam.get(team)!;
            if (blob.color === 'teal') mergedTeal++; else mergedRed++;
            mergedIcons += n;
            const inside = identifyInBlob(frame, blob, diam, sets, n);
            mergedNamed += inside.length;
            for (const ni of inside) {
              sheetCells.push({ crop: img, cx: ni.x, cy: ni.y, art: art.get(ni.id) ?? null, decided: true });
              mergedCells.push(sheetCells.length - 1);
            }
          }
          for (const { b: blob, strict } of lone) {
            const team = blob.color === 'teal' ? b.team : other;
            const { sets, art } = byTeam.get(team)!;
            const t0 = Date.now();
            const ranked = MODE === 'wide' ? wideMatch(frame, blob.cx, blob.cy, diam, sets)
              : MODE === 'app' ? matchIcon(frame, blob.cx, blob.cy, diam, sets)
              : identifyIcon(frame, blob.cx, blob.cy, diam, sets);
            matchMs += Date.now() - t0; matched++;
            const decided = decideMatch(ranked);
            if (!strict) { looseSeen++; if (!decided) continue; looseNamed++; }
            const inBox = !!vp.box && blob.cx >= vp.box.x0 && blob.cx <= vp.box.x1 && blob.cy >= vp.box.y0 && blob.cy <= vp.box.y1;
            rows.push({ idx: rows.length, cell: sheetCells.length, bundle: b.dir, snap, colour: blob.color, kind: strict ? 'single' : 'loose', x: blob.cx, y: blob.cy, inBox, ranked, decided });
            sheetCells.push({ crop: img, cx: blob.cx, cy: blob.cy, art: art.get(decided ?? ranked[0].id) ?? null, decided: !!decided });
          }
        }
      }
    }

    // CSV
    const csv = ['idx,bundle,snap,colour,x,y,inBox,best,bestScore,second,secondScore,decided'];
    for (const r of rows) {
      csv.push([r.idx, r.bundle, r.snap, r.colour, r.x, r.y, r.inBox, r.ranked[0]?.id, r.ranked[0]?.score.toFixed(3),
        r.ranked[1]?.id, r.ranked[1]?.score.toFixed(3), r.decided ?? ''].join(','));
    }
    fs.writeFileSync(path.join(outDir, 'icons.csv'), csv.join('\n'));
    fs.writeFileSync(path.join(outDir, 'boxes.csv'), boxCsv.join('\n'));
    fs.writeFileSync(path.join(outDir, 'single-spans.csv'), spanRows.join('\n'));
    // Snapshots with the box found drawn in green, 12 a page, and every one it
    // missed, to check by eye.
    const shotsDir = path.join(outDir, 'boxes');
    fs.mkdirSync(shotsDir, { recursive: true });
    const pages = (list: RgbaImage[], prefix: string): void => {
      for (let i = 0; i < list.length; i += 12) {
        fs.writeFileSync(path.join(shotsDir, `${prefix}-${String(i / 12).padStart(2, '0')}.png`),
          encodePng(mosaic(list.slice(i, i + 12), 4)));
      }
    };
    pages(boxShots.filter(s => s.found).map(s => s.img), 'found');
    pages(boxShots.filter(s => !s.found).map(s => s.img), 'missed');

    // Contact sheets, one per game, colour and best-matching player, highest
    // margin first: what the matcher would say for each icon, so the wrong ones
    // stand out when checked by eye. Each cell is the crop, that player's icon,
    // and a bar (green named / grey unsure). The order is in sheets.csv.
    const COLS = 10, PER = 100;
    const margin = (r: Row): number => r.ranked[0].score - (r.ranked[1]?.score ?? 0);
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const g = spec.games.findIndex(gm => gm.bundles.some(b => b.dir === r.bundle));
      const key = `g${g}-${r.colour}-${r.ranked[0].id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const sheetCsv = ['sheet,pos,idx,bundle,snap,x,y,bestScore,margin,decided'];
    for (const [key, members] of groups) {
      members.sort((a, b) => margin(b) - margin(a));
      members.forEach((r, pos) => sheetCsv.push([key, pos, r.idx, r.bundle, r.snap, r.x, r.y,
        r.ranked[0].score.toFixed(3), margin(r).toFixed(3), r.decided ?? ''].join(',')));
    }
    fs.writeFileSync(path.join(outDir, 'sheets.csv'), sheetCsv.join('\n'));
    for (const [key, members] of groups) {
      writeSheet(key, members.map(r => sheetCells[r.cell]));
    }
    if (mergedCells.length) writeSheet('merged', mergedCells.map(i => sheetCells[i]));
    function writeSheet(name: string, all: typeof sheetCells): void {
      for (let s = 0; s * PER < all.length; s++) {
      const cells = all.slice(s * PER, (s + 1) * PER);
      const rowsN = Math.ceil(cells.length / COLS);
      const W = COLS * (CELL * 2 + 6), H = rowsN * (CELL + 8);
      const sheet: RgbaImage = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
      for (let i = 0; i < W * H; i++) { sheet.data[i * 4 + 3] = 255; sheet.data[i * 4] = sheet.data[i * 4 + 1] = sheet.data[i * 4 + 2] = 255; }
      cells.forEach((c, i) => {
        const x0 = (i % COLS) * (CELL * 2 + 6), y0 = Math.floor(i / COLS) * (CELL + 8);
        const side = diam * 1.1;
        blit(sheet, x0, y0, c.crop, c.cx - side / 2, c.cy - side / 2, side, side, CELL);
        if (c.art) blit(sheet, x0 + CELL, y0, c.art, 0, 0, c.art.width, c.art.height, CELL);
        for (let y = y0 + CELL + 1; y < y0 + CELL + 6; y++) {
          for (let x = x0; x < x0 + CELL * 2; x++) {
            const o = (y * W + x) * 4;
            if (c.decided) { sheet.data[o] = 40; sheet.data[o + 1] = 170; sheet.data[o + 2] = 60; }
            else { sheet.data[o] = sheet.data[o + 1] = sheet.data[o + 2] = 170; }
          }
        }
      });
      fs.writeFileSync(path.join(outDir, `${name}${s > 0 ? '-' + s : ''}.png`), encodePng(sheet));
      }
    }

    const tally = (f: (r: Row) => boolean): string => {
      const sel = rows.filter(f);
      const named = sel.filter(r => r.decided).length;
      return `${sel.length} icons, named ${named} (${sel.length ? Math.round((100 * named) / sel.length) : 0}%)`;
    };
    const summary = [
      `snapshots ${snaps} in game (${loading} loading screens skipped; a box found on ${loadingBoxes} of them)`,
      `camera box: fixed-size search ${boxes} (${Math.round((100 * boxes) / snaps)}%), old reader ${oldBoxes} (${Math.round((100 * oldBoxes) / snaps)}%), disagreeing by >3px ${disagree}`,
      `merged blobs: teal ${mergedTeal}, red ${mergedRed}; ~${mergedIcons} icons in them, ${mergedNamed} named (${Math.round((100 * mergedNamed) / Math.max(1, mergedIcons))}%)`,
      `strict single icons by span (x0.1 icon): ${JSON.stringify(spanHist)}`,
      `filled icon-shaped blobs (art in the ring colour): ${looseSeen}, ${looseNamed} recognised and kept`,
      `matching: ${matched} icons, ${(matchMs / Math.max(1, matched)).toFixed(1)} ms each (mode ${MODE})`,
      `teal: ${tally(r => r.colour === 'teal')}`,
      `red:  ${tally(r => r.colour === 'red')}`,
      `inside the camera box: ${tally(r => r.inBox)}`,
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);
    console.log(summary);
    expect(rows.length).toBeGreaterThan(0);
  });
});
