// Camera-mode scenes: champions' real base icons, ringed in their team's
// colour, moving over the real Summoner's Rift minimap, with the white camera
// rectangle — rendered into capture frames for the real TrackingService, with
// the ground truth of who is inside the box on every frame.
//
// The icon art is Community Dragon's (scripts/fetch-minimap-icons.mjs, into
// tests/cv/fixtures-icons/); the background is fixtures-real's. Neither is
// committed, and loadCameraArt() returns null without them.

import * as fs from 'fs';
import * as path from 'path';
import { decodePng, RgbaImage } from './png';
import { blankFrame, encodeFrame, SynthFrame, RED, TEAL, WHITE } from './frames';
import { CAPTURE_SIZE, ICON_DIAM, REGION } from './scenes';
import { loadRealArt } from './real';
import { iconFilesForSkin, iconTemplates } from '../../../src/services/skin-matcher';
import { expectedBoxSize } from '../../../src/services/camera-box';

const ICON_DIR = path.join(__dirname, '..', 'fixtures-icons');

export interface CameraArt {
  background: Uint8Array | null;
  /** Base icon image(s) per champion alias; [0] is the one drawn. */
  icons: Map<string, RgbaImage[]>;
}

export function loadCameraArt(aliases: string[]): CameraArt | null {
  const icons = new Map<string, RgbaImage[]>();
  try {
    for (const alias of aliases) {
      const dir = path.join(ICON_DIR, alias);
      const listing = fs.readFileSync(path.join(dir, '_listing.html'), 'utf8');
      const files = iconFilesForSkin(listing, alias, 0);
      if (files.length === 0) return null;
      // The plain base icon first: forms (Kayn, Gnar...) are extra templates.
      files.sort((a, b) => a.length - b.length);
      icons.set(alias, files.map((f) => decodePng(fs.readFileSync(path.join(dir, f)))));
    }
  } catch {
    return null;
  }
  return { background: loadRealArt()?.background ?? null, icons };
}

/** Templates for a champion, as the app builds them (loadBaseTemplates). */
export function templatesFor(art: CameraArt, alias: string): Float32Array[] {
  return art.icons.get(alias)!.flatMap((img) => iconTemplates(img.data, img.width, img.height));
}

export type Side = 'ally' | 'enemy';

export interface SceneIcon {
  id: string;
  alias: string;
  side: Side;
  /** Region px; null = not drawn (fog of war, dead). */
  at: { x: number; y: number } | null;
}

export interface CameraFrameSpec {
  icons: SceneIcon[];
  /** Top-left of the camera box, region px; null = not drawn. */
  box: { x0: number; y0: number } | null;
}

export const BOX = expectedBoxSize(REGION.width);

function put(f: SynthFrame, x: number, y: number, rgb: ArrayLike<number>, a = 1): void {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= f.width || py >= f.height) return;
  const o = (py * f.width + px) * 4;
  for (let c = 0; c < 3; c++) f.data[o + c] = Math.round(f.data[o + c] * (1 - a) + rgb[c] * a);
}

/**
 * An icon as the minimap draws it: the portrait, area-sampled down to the
 * icon's size, inside a two-pixel ring of the team colour.
 */
function drawIcon(f: SynthFrame, cx: number, cy: number, img: RgbaImage, ring: ArrayLike<number>): void {
  const r = ICON_DIAM / 2;
  const portraitR = r - 2;
  const side = Math.min(img.width, img.height);
  // Source pixels per destination pixel across the portrait's diameter.
  const scale = side / (2 * portraitR);
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > portraitR) { put(f, cx + dx, cy + dy, ring); continue; }
      // Area-average the source square under this destination pixel.
      const sx0 = (dx + portraitR - 0.5) * scale + (img.width - side) / 2;
      const sy0 = (dy + portraitR - 0.5) * scale + (img.height - side) / 2;
      const acc = [0, 0, 0];
      let wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.floor(sy0 + scale); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.floor(sx0 + scale); sx++) {
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
          const o = (sy * img.width + sx) * 4;
          const a = img.data[o + 3] / 255;
          for (let c = 0; c < 3; c++) acc[c] += img.data[o + c] * a;
          wsum += a;
        }
      }
      if (wsum > 0) put(f, cx + dx, cy + dy, acc.map((v) => v / wsum));
    }
  }
}

/**
 * One capture frame. Enemies are drawn first and allies over them, the way
 * League stacks an ally's icon over an enemy's.
 */
export function renderCameraFrame(art: CameraArt, spec: CameraFrameSpec): ArrayBuffer {
  const f = blankFrame(CAPTURE_SIZE, CAPTURE_SIZE);
  if (art.background) {
    for (let y = 0; y < REGION.height; y++) {
      for (let x = 0; x < REGION.width; x++) {
        const i = (y * REGION.width + x) * 4;
        put(f, REGION.x + x, REGION.y + y, [art.background[i], art.background[i + 1], art.background[i + 2]]);
      }
    }
  }
  const order = [...spec.icons].sort((a, b) => (a.side === b.side ? 0 : a.side === 'enemy' ? -1 : 1));
  for (const icon of order) {
    if (!icon.at) continue;
    drawIcon(f, REGION.x + icon.at.x, REGION.y + icon.at.y, art.icons.get(icon.alias)![0], icon.side === 'ally' ? TEAL : RED);
  }
  if (spec.box) {
    const { x0, y0 } = spec.box;
    for (let x = x0; x <= x0 + BOX.w; x++) { put(f, REGION.x + x, REGION.y + y0, WHITE); put(f, REGION.x + x, REGION.y + y0 + BOX.h, WHITE); }
    for (let y = y0; y <= y0 + BOX.h; y++) { put(f, REGION.x + x0, REGION.y + y, WHITE); put(f, REGION.x + x0 + BOX.w, REGION.y + y, WHITE); }
  }
  return encodeFrame(f);
}

/**
 * Who should be heard: every icon drawn with its centre inside the box, the
 * local player left out. `unsure`: icons too close to the box edge to call
 * (within half an icon either side), which a scorer leaves out of the count.
 */
export function truthFor(spec: CameraFrameSpec, selfId: string): { heard: Set<string>; unsure: Set<string> } {
  const heard = new Set<string>();
  const unsure = new Set<string>();
  if (!spec.box) return { heard, unsure };
  const { x0, y0 } = spec.box;
  const x1 = x0 + BOX.w, y1 = y0 + BOX.h;
  const m = ICON_DIAM / 2;
  for (const icon of spec.icons) {
    if (!icon.at || icon.id === selfId) continue;
    const { x, y } = icon.at;
    const insideBy = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    if (Math.abs(insideBy) < m) unsure.add(icon.id);
    else if (insideBy > 0) heard.add(icon.id);
  }
  return { heard, unsure };
}

/** A point `t` (0..1) of the way from a to b. */
export function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Optional: write a frame out as PNG to look at (debugging a scene). */
export function savePng(file: string, frame: ArrayBuffer): void {
  // Lazy import keeps the encoder out of the hot path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { encodePng } = require('./png') as typeof import('./png');
  const dv = new DataView(frame);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  const data = new Uint8ClampedArray(frame.slice(8));
  fs.writeFileSync(file, encodePng({ data, width: w, height: h }));
}
