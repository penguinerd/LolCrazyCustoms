// Camera mode: you hear exactly the players whose minimap icons are inside
// your camera rectangle. Nobody else — not even someone beside you whose icon
// is outside it — and nobody the fog of war hides, because the minimap only
// draws who your team can see.
//
// Each player's app applies the rule for itself, so the pair is decided from
// both ends: I hear you when your icon is in MY box; you hear me when mine is
// in YOURS. Looking at someone never makes them hear you.
//
// Nothing here needs to know where the local player is, which is what made
// proximity fragile (a skin, a teammate on top, a turret, and the tracker
// followed the wrong icon). It needs three things off the minimap:
//
// - the camera box (camera-box.ts),
// - every champion icon, with its team from the ring colour,
// - whose each icon is (icon-identity.ts), against the base icons of the
//   five players of that team.
//
// Icons are followed from frame to frame (tracks), so an icon named once keeps
// its name while it walks under another and cannot be told apart. Nobody
// vanishes without a reason: a teammate alive is always drawn, so one whose
// icon disappears beside another ally icon is under it and goes wherever it
// goes (an enemy too, briefly, when it disappears right under an ally's icon);
// only death (League's live data) or, for an enemy, the fog takes a player
// off the map. What stays unnamed is settled by elimination over the whole
// map: each unknown icon is at most one player — alive, not placed elsewhere,
// and able to have walked there — the surest pairs first.
//
// Viego possessing a dead champion is drawn with that champion's icon in his
// own team's ring, so while he is alive he is also matched against the icons
// of the other team's dead (matchSets).

import type { CaptureFrame } from '../core/capture-frame';
import type { Blob } from './blob-types';
import { CameraBox, CameraBoxTracker } from './camera-box';
import { describeViewportCenter } from './tracking-helpers';
import { identifyIcon, identifyInBlob } from './icon-identity';
import { decideMatch, MatchScore, TemplateSet } from './skin-matcher';

export type Side = 'ally' | 'enemy';

export interface HearingPlayer {
  /** Identifies the player to the caller (orchestrator: team + champion). */
  id: string;
  side: Side;
  /** The local player: matched like anyone (so their icon is not taken for a
   *  teammate's) but never in the audible set. */
  self?: boolean;
  /** skin-matcher templates of their champion's base icon(s). */
  vecs: Float32Array[];
  /** Can take a dead enemy champion's form, icon included (Viego). */
  possesses?: boolean;
}

/** One icon seen this tick, region-relative px. */
export interface IconObservation {
  side: Side;
  x: number;
  y: number;
  /** Whose it is, when that was decided this tick. */
  id: string | null;
  /** Every candidate's score, when it was matched this tick. */
  scores?: Map<string, number>;
}

interface Track {
  side: Side;
  x: number;
  y: number;
  id: string | null;
  seenMs: number;
  /** When an icon was last actually observed for it; seenMs also moves while
   *  it is covered (a sliver of its ring still showing). */
  observedMs: number;
  /** When the icon was last matched (named or not). */
  checkedMs: number;
  /** The last scores against each candidate, for elimination. */
  scores: Map<string, number> | null;
  /** When this track started (its icon first appeared). */
  bornMs: number;
}

/** How often icons are matched against the players. */
export const IDENTIFY_INTERVAL_MS = 250;
/** An icon named this recently is not matched again... */
export const RECHECK_MS = 2000;
/** ...or, in or near the box (where a wrong name would be heard), this recently. */
export const RECHECK_NEAR_MS = 750;
/** Most single icons matched per tick (~10 ms each). */
export const MATCH_BUDGET = 4;
/** A track not seen for this long is forgotten. */
export const TRACK_TTL_MS = 1000;
/** How far an icon may move between ticks and stay the same track, in icon
 *  diameters: a champion at 500 u/s covers ~3 px of a 341 px minimap in a
 *  quarter second; Flash about 9. */
export const TRACK_REACH_DIAMS = 0.9;
/** What is inside the box: its centre within this many icon diameters of it,
 *  so an icon half in counts. */
export const BOX_MARGIN_DIAMS = 0.25;
/** With the box unknown (not on the minimap, game minimised), what was heard
 *  goes on this long, then nobody. */
export const AUDIBLE_HOLD_MS = 1000;
/** An enemy whose icon is not seen as its own, but with red ring still showing
 *  on its outline that no other enemy's ring explains, is drawn but hidden —
 *  under an ally's icon (League draws allies on top) or merged with another
 *  enemy's — not gone: its track lives on this long. The fog of war takes the
 *  whole ring away. */
export const COVERED_MAX_MS = 6000;
/** Red pixels on an icon's outline that say its ring still shows. */
export const COVERED_MIN_RING_PX = 6;
/** A name already on a live track elsewhere is moved to a new icon only on a
 *  match this strong: champions do not jump across the map, and two icons
 *  stacked into one blob can resemble a third player. */
export const MOVE_NAME_MIN_SCORE = 0.8;
/** How far a champion can get on the minimap per second, in icon diameters:
 *  ~13 px/s on a 341 px minimap, about 580 units/s — a fast champion with
 *  room for dashes. Who could not have walked from where they were last
 *  named to an unknown icon is not that icon. */
export const REACH_DIAMS_PER_SEC = 0.45;
/** Added to that walk: a Flash and a dash on top of it. */
export const REACH_SLACK_DIAMS = 1.5;
/** A teammate's icon that vanishes this close to another teammate's (icon
 *  diameters) is under it, not gone: alive, an ally is always drawn. */
export const HIDDEN_NEAR_DIAMS = 1.2;
/** An enemy's icon that vanishes this close to an ally's is under it (League
 *  draws allies on top) — in a fight, among other rings, often with no sliver
 *  of its own ring left for coveredEnemies to see. Held at most
 *  COVERED_MAX_MS, since an enemy right beside an ally may instead have
 *  stepped into a brush. */
export const ENEMY_HIDDEN_NEAR_DIAMS = 0.7;
/** An ally on no icon is put under the ally icon nearest where they were last
 *  seen, if that was this recently. */
export const ALLY_UNPLACED_MS = 3000;

export class CameraHearing {
  private players: HearingPlayer[] = [];
  private setsBySide: Record<Side, TemplateSet[]> = { ally: [], enemy: [] };
  private readonly boxTracker = new CameraBoxTracker();
  private box: CameraBox | null = null;
  private tracks: Track[] = [];
  private lastIdentifyMs = -Infinity;
  private lastAudible: Set<string> = new Set();
  private lastAudibleMs = -Infinity;
  /** Where each player was last named on the minimap. */
  private lastSeen = new Map<string, { x: number; y: number; ms: number }>();
  /** Players League says are dead: no icon, never anyone's unknown icon. */
  private dead: Set<string> = new Set();
  /** Players hidden under an ally's icon (`host`), following it until they
   *  show again; `firstMs` is when they were first hidden. */
  private riders = new Map<string, { host: Track; sinceMs: number; firstMs: number }>();
  /** Ids on a track at the end of the last ingest, to see who vanished. */
  private prevNamed = new Set<string>();

  /** `iconDiam` until the first frame says otherwise (it follows the
   *  minimap's size, as TrackingService.expectedIconDiam does). */
  constructor(private iconDiam = 30) {}

  setPlayers(players: HearingPlayer[]): void {
    this.players = players;
    this.setsBySide = matchSets(players, this.dead);
    this.tracks = [];
    this.lastSeen.clear();
    this.riders.clear();
    this.prevNamed.clear();
  }

  /** The players League's live data says are dead right now (ids). */
  setDead(ids: Iterable<string>): void {
    const dead = new Set(ids);
    const changed = dead.size !== this.dead.size || [...dead].some((id) => !this.dead.has(id));
    this.dead = dead;
    if (changed) this.setsBySide = matchSets(this.players, dead);
  }

  hasPlayers(): boolean {
    return this.setsBySide.ally.length + this.setsBySide.enemy.length > 0;
  }

  /**
   * One captured frame. `blobs` are every ring blob the tracker found (region
   * px), `singles` the ones filterIconBlobs took for one icon each, and
   * `viewportMask` the white straight-run mask it builds. `region` places the
   * minimap inside `frame`.
   */
  onFrame(
    frame: CaptureFrame,
    region: { x: number; y: number; width: number; height: number },
    blobs: Blob[],
    singles: Blob[],
    viewportMask: Uint8Array,
    nowMs: number,
  ): void {
    this.iconDiam = Math.max(8, Math.round(region.width * 0.087));
    this.box = this.boxTracker.update(viewportMask, region.width, region.height, nowMs);
    if (nowMs - this.lastIdentifyMs < IDENTIFY_INTERVAL_MS) return;
    this.lastIdentifyMs = nowMs;
    // A box read whole by its two pairs of edges teaches its true size, for a
    // screen that is not 16:9 (an ultrawide's box is wider).
    const whole = describeViewportCenter(viewportMask, region.width, region.height).box;
    if (whole) this.boxTracker.noteWholeBox(whole);
    const obs = this.observe(frame, region, blobs, singles, nowMs);
    this.ingest(obs, nowMs, this.coveredEnemies(frame, region, obs, nowMs));
  }

  /** The camera box this frame (held briefly when unreadable), region px. */
  getBox(): CameraBox | null {
    return this.box;
  }

  /**
   * Ids of the players to hear now: every icon inside the box, named or
   * settled by elimination, the local player left out.
   *
   * Elimination never hears more players than there are unknown icons in the
   * box (a pile-up of two used to make four audible), and only ever names an
   * icon after someone who could be there: alive, not named elsewhere, and
   * near enough to where they were last named to have walked to it.
   */
  audible(nowMs: number): Set<string> {
    if (!this.box) {
      return nowMs - this.lastAudibleMs <= AUDIBLE_HOLD_MS ? this.lastAudible : new Set();
    }
    const out = new Set<string>();
    for (const [id, t] of this.placeAll(nowMs)) if (this.inBox(t)) out.add(id);
    for (const p of this.players) if (p.self) out.delete(p.id);
    for (const id of this.dead) out.delete(id);
    this.lastAudible = out;
    this.lastAudibleMs = nowMs;
    return out;
  }

  /**
   * Where every player alive is on the minimap now, as far as can be told: the
   * icon (track) each is on. Nobody vanishes without a reason — a player is
   * named on an icon, hidden under one (riders, see ingest), or one of the
   * unknown icons; only an enemy can also be in the fog (absent here).
   *
   * Unknown icons are settled over the WHOLE map, the surest pairs first (a
   * strong look-alike, then the player last named nearest), each icon one
   * player at most and only someone who could have walked to it.
   */
  private placeAll(nowMs: number): Map<string, Track> {
    const at = new Map<string, Track>();
    const live = this.tracks.filter((t) => nowMs - t.seenMs <= TRACK_TTL_MS);
    for (const t of live) if (t.id) at.set(t.id, t);
    for (const side of ['ally', 'enemy'] as Side[]) {
      const unknown = live.filter((t) => t.side === side && !t.id);
      // Riders are candidates too: one showing again beside the icon they
      // were under is that new unknown icon.
      const cands = this.players.filter((p) => p.side === side && !at.has(p.id) && !this.dead.has(p.id)).map((p) => p.id);
      for (const [id, t] of this.assignUnknown(unknown, cands, nowMs)) at.set(id, t);
      for (const id of cands) {
        const r = this.riders.get(id);
        if (!at.has(id) && r && live.includes(r.host)) at.set(id, r.host);
      }
      if (side !== 'ally') continue;
      // An ally alive is always drawn: one on no icon a moment after being
      // seen is under the ally icon nearest where they were (a detection
      // miss, a stack the riders did not catch).
      const allyIcons = live.filter((t) => t.side === 'ally');
      for (const id of cands) {
        const seen = this.lastSeen.get(id);
        if (at.has(id) || !seen || nowMs - seen.ms > ALLY_UNPLACED_MS) continue;
        const host = bestBy(allyIcons.filter((t) => this.couldBeAt(id, t, nowMs)),
          (t) => -Math.hypot(t.x - seen.x, t.y - seen.y));
        if (host) at.set(id, host);
      }
    }
    return at;
  }

  /**
   * Which unknown icon each candidate is. Pairs are taken surest first: an
   * icon matched against the players goes to whoever it looked most like;
   * then icons never matched (inside a merged blob) go to whoever was last
   * named nearest them. Players never named at all are placed only when they
   * are the only ones left for the icons left, and only when where exactly
   * does not matter (all those icons inside the box, or all outside).
   */
  private assignUnknown(unknown: Track[], cands: string[], nowMs: number): Map<string, Track> {
    const placed = new Map<string, Track>();
    const usedIcons = new Set<Track>();
    const pairs: Array<{ t: Track; id: string; tier: number; cost: number }> = [];
    for (const t of unknown) {
      for (const id of cands) {
        if (!this.couldBeAt(id, t, nowMs)) continue;
        if (t.scores) pairs.push({ t, id, tier: 0, cost: -(t.scores.get(id) ?? -1) });
        else if (this.lastSeen.has(id)) pairs.push({ t, id, tier: 1, cost: this.distFromLastSeen(id, t) });
      }
    }
    pairs.sort((a, b) => a.tier - b.tier || a.cost - b.cost);
    for (const { t, id } of pairs) {
      if (placed.has(id) || usedIcons.has(t)) continue;
      placed.set(id, t);
      usedIcons.add(t);
    }
    const iconsLeft = unknown.filter((t) => !usedIcons.has(t) && !t.scores);
    const neverSeen = cands.filter((id) => !placed.has(id) && !this.lastSeen.has(id));
    const sameSide = iconsLeft.every((t) => this.inBox(t)) || iconsLeft.every((t) => !this.inBox(t));
    if (neverSeen.length > 0 && neverSeen.length <= iconsLeft.length && sameSide) {
      neverSeen.forEach((id, i) => placed.set(id, iconsLeft[i]));
    }
    return placed;
  }

  /** Whether player `id` can be the icon at `p`: never named yet, or named
   *  recently enough near it to have walked there. The local player is
   *  always placeable (a recall). */
  private couldBeAt(id: string, p: { x: number; y: number }, nowMs: number): boolean {
    if (this.players.some((q) => q.id === id && q.self)) return true;
    const seen = this.lastSeen.get(id);
    if (!seen) return true;
    const reach = this.iconDiam * (REACH_SLACK_DIAMS + REACH_DIAMS_PER_SEC * Math.max(0, nowMs - seen.ms) / 1000);
    return Math.hypot(seen.x - p.x, seen.y - p.y) <= reach;
  }

  private distFromLastSeen(id: string, p: { x: number; y: number }): number {
    const seen = this.lastSeen.get(id);
    return seen ? Math.hypot(seen.x - p.x, seen.y - p.y) : Infinity;
  }

  /** For the log: each live track, `id@x,y` or `?@x,y`, `*` inside the box. */
  describe(nowMs: number): string {
    return this.tracks
      .filter((t) => nowMs - t.seenMs <= TRACK_TTL_MS)
      .map((t) => (t.side === 'ally' ? 'A:' : 'E:') + (t.id ?? '?') + '@' + Math.round(t.x) + ',' + Math.round(t.y) +
        (this.inBox(t) ? '*' : ''))
      .concat([...this.riders].map(([id, r]) => (r.host.side === 'ally' ? 'A' : 'E') + ':' + id + '~under' +
        (r.host.id ?? '?') + (this.inBox(r.host) ? '*' : '')))
      .join(' ');
  }

  reset(): void {
    this.tracks = [];
    this.boxTracker.reset();
    this.box = null;
    this.lastAudible = new Set();
    this.lastAudibleMs = -Infinity;
    this.lastSeen.clear();
    this.riders.clear();
    this.prevNamed.clear();
  }

  // ---- internals ----

  private inBox(p: { x: number; y: number }): boolean {
    const b = this.box;
    if (!b) return false;
    const m = this.iconDiam * BOX_MARGIN_DIAMS;
    return p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m;
  }

  /** Distance from the box in px (0 inside), Infinity with no box. */
  private boxDistance(p: { x: number; y: number }): number {
    const b = this.box;
    if (!b) return Infinity;
    const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
    const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
    return Math.hypot(dx, dy);
  }

  /** This tick's icons: single blobs matched when worth it (in budget order),
   *  merged blobs split into the players recognisable inside them. */
  private observe(
    frame: CaptureFrame,
    region: { x: number; y: number; width: number; height: number },
    blobs: Blob[],
    singles: Blob[],
    nowMs: number,
  ): IconObservation[] {
    const diam = this.iconDiam;
    const sideOf = (b: Blob): Side => (b.color === 'teal' ? 'ally' : 'enemy');
    const obs: IconObservation[] = [];

    // What one icon's ring weighs in pixels: the median of this tick's icons
    // that are clearly alone (no wider than one icon), else about ten pixels
    // per pixel of diameter, as measured on real and simulated minimaps.
    const weights = singles.filter((b) => Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) <= diam * 1.15)
      .map((b) => b.pixels).sort((a, b) => a - b);
    const ringPx = weights.length > 0 ? weights[Math.floor(weights.length / 2)] : diam * 10;

    // Every blob that is icons: how many each holds, by span and by weight —
    // two enemies a few pixels apart make one blob the size of one icon, but
    // with two rings' worth of red in it.
    const { lone, merged } = classifyIconBlobs(blobs, singles, diam, ringPx);

    // Single icons: decide which to match this tick. One the tracker's filter
    // turned down as too filled (art in the ring's colour, or minions) is an
    // icon only if it is recognised, or continues a track that was.
    const queue = lone.map(({ b, strict }) => {
      const prev = this.nearestTrack(sideOf(b), b.cx, b.cy, nowMs);
      const near = this.boxDistance({ x: b.cx, y: b.cy }) <= diam;
      const since = prev ? nowMs - prev.checkedMs : Infinity;
      const stale = !prev?.id || since >= (near ? RECHECK_NEAR_MS : RECHECK_MS);
      const mustMatch = !strict && !prev?.id;
      return {
        b, strict, mustMatch,
        need: stale || mustMatch,
        prio: (near ? 0 : 2) + (prev?.id ? 1 : 0),
        checked: prev?.checkedMs ?? -Infinity,
      };
    }).sort((a, b) => a.prio - b.prio || a.checked - b.checked);
    let budget = MATCH_BUDGET;
    for (const q of queue) {
      const side = sideOf(q.b);
      const o: IconObservation = { side, x: q.b.cx, y: q.b.cy, id: null };
      if (q.need && budget > 0 && this.setsBySide[side].length > 0) {
        budget--;
        const ranked = identifyIcon(frame, region.x + q.b.cx, region.y + q.b.cy, diam, this.setsBySide[side]);
        o.id = decideMatch(ranked);
        o.scores = toMap(ranked);
      }
      if (q.mustMatch && !o.id) continue;
      obs.push(o);
    }

    // Merged blobs (several icons, a fight): split near the box only — far
    // away they matter only for elimination, which named tracks already feed.
    for (const { b, n } of merged) {
      const side = sideOf(b);
      const near = this.boxDistance({ x: b.cx, y: b.cy }) <= diam * 1.5;
      const named = near && this.setsBySide[side].length > 0
        ? identifyInBlob(frame, shiftBlob(b, region.x, region.y), diam, this.setsBySide[side], n)
        : [];
      for (const ni of named) {
        obs.push({ side, x: ni.x - region.x, y: ni.y - region.y, id: ni.id, scores: new Map([[ni.id, ni.score]]) });
      }
      // The rest, spread over the blob so they land on the tracks of whoever
      // walked into it.
      for (let i = named.length; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const wide = b.maxX - b.minX >= b.maxY - b.minY;
        obs.push({
          side,
          x: wide ? b.minX + diam / 2 + t * Math.max(0, b.maxX - b.minX - diam) : b.cx,
          y: wide ? b.cy : b.minY + diam / 2 + t * Math.max(0, b.maxY - b.minY - diam),
          id: null,
        });
      }
    }
    return obs;
  }

  /**
   * Fold one tick's observations into the tracks. `marks`: where covered
   * enemies were found (coveredEnemies), which keeps their tracks alive.
   */
  ingest(obs: IconObservation[], nowMs: number, marks: Trace[] = []): void {
    const reach = this.iconDiam * TRACK_REACH_DIAMS;
    this.tracks = this.tracks.filter((t) => nowMs - t.seenMs <= TRACK_TTL_MS);
    const free = new Set(this.tracks);
    // Named observations first, so a name lands on the track it belongs to.
    const ordered = [...obs].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1)).map((o) => {
      if (!o.id) return o;
      // A name live on a track far from here stays there unless this match
      // is strong: no champion crosses the map in a quarter second.
      const elsewhere = this.tracks.find((t) => t.id === o.id && Math.hypot(t.x - o.x, t.y - o.y) > reach * 2);
      const score = o.scores?.get(o.id) ?? -Infinity;
      return elsewhere && score < MOVE_NAME_MIN_SCORE ? { ...o, id: null } : o;
    });
    for (const o of ordered) {
      // The track this icon continues: the one already carrying its name if
      // near enough, else the nearest free one of its side.
      let track: Track | null = null;
      if (o.id) {
        const same = [...free].find((t) => t.id === o.id && Math.hypot(t.x - o.x, t.y - o.y) <= reach * 2);
        if (same) track = same;
      }
      if (!track) {
        let bestD = reach;
        for (const t of free) {
          if (t.side !== o.side) continue;
          const d = Math.hypot(t.x - o.x, t.y - o.y);
          if (d <= bestD && (!o.id || !t.id || t.id === o.id)) { bestD = d; track = t; }
        }
      }
      if (!track) {
        track = { side: o.side, x: o.x, y: o.y, id: null, seenMs: nowMs, observedMs: nowMs, checkedMs: -Infinity, scores: null, bornMs: nowMs };
        this.tracks.push(track);
      } else {
        free.delete(track);
      }
      track.x = o.x;
      track.y = o.y;
      track.seenMs = nowMs;
      track.observedMs = nowMs;
      if (o.scores) {
        track.scores = o.scores;
        track.checkedMs = nowMs;
      }
      if (o.id) {
        // A player is one icon: their name comes off any other track.
        for (const t of this.tracks) if (t !== track && t.id === o.id) t.id = null;
        track.id = o.id;
        track.checkedMs = nowMs;
      } else if (o.scores && track.id) {
        // Matched and not recognised: keep the name (covered, merged) unless
        // the icon now clearly looks like someone else.
        const own = o.scores.get(track.id) ?? -Infinity;
        const top = Math.max(...o.scores.values());
        if (top - own >= 0.3) track.id = null;
      }
    }
    // Tracks with no icon this tick that are covered, not gone.
    const r = this.iconDiam * 0.5;
    for (const t of free) {
      if (nowMs - t.observedMs > COVERED_MAX_MS) continue;
      const covered = marks.some((m) => m.side === t.side &&
        t.x >= m.minX - r && t.x <= m.maxX + r && t.y >= m.minY - r && t.y <= m.maxY + r);
      if (covered) t.seenMs = nowMs;
    }
    for (const t of this.tracks) {
      if (t.id && t.seenMs === nowMs) this.lastSeen.set(t.id, { x: t.x, y: t.y, ms: nowMs });
    }
    this.updateRiders(nowMs);
  }

  /**
   * Who is hidden under an ally's icon (League draws allies on top of
   * everyone). An ally alive is always drawn, so a teammate whose icon
   * vanishes beside another ally icon is under it — however many pile up —
   * and from then on is wherever that icon is: two champions stacked walk
   * together. An enemy is taken for hidden only when it vanishes right on top
   * of an ally's icon, and for COVERED_MAX_MS at most. Riders stop riding when
   * named again, when dead, or when the icon they were under is gone with no
   * other beside it to take them on.
   */
  private updateRiders(nowMs: number): void {
    const named = new Set(this.tracks.flatMap((t) => (t.id ? [t.id] : [])));
    const isAlly = (id: string): boolean => this.players.some((p) => p.id === id && p.side === 'ally');
    const nearFor = (id: string): number => this.iconDiam * (isAlly(id) ? HIDDEN_NEAR_DIAMS : ENEMY_HIDDEN_NEAR_DIAMS);
    const near = this.iconDiam * HIDDEN_NEAR_DIAMS;
    const hostNear = (p: { x: number; y: number }, reach: number): Track | null =>
      bestBy(this.tracks.filter((t) => t.side === 'ally' && Math.hypot(t.x - p.x, t.y - p.y) <= reach),
        (t) => -Math.hypot(t.x - p.x, t.y - p.y));
    const emerged = new Set<Track>();
    for (const [id, r] of this.riders) {
      if (!isAlly(id) && nowMs - r.firstMs > COVERED_MAX_MS) {
        this.riders.delete(id);
        continue;
      }
      if (named.has(id) || this.dead.has(id)) {
        this.riders.delete(id);
        continue;
      }
      if (!this.tracks.includes(r.host)) {
        const next = hostNear(r.host, nearFor(id));
        if (!next) { this.riders.delete(id); continue; }
        r.host = next;
      }
      // Showing again: a new unknown icon of their side right beside the pile
      // is them, and from now on they are that icon (it is matched and named
      // soon).
      const side: Side = isAlly(id) ? 'ally' : 'enemy';
      const shown = bestBy(this.tracks.filter((t) => t.side === side && !t.id && t !== r.host &&
        t.bornMs > r.sinceMs && !emerged.has(t) && Math.hypot(t.x - r.host.x, t.y - r.host.y) <= near),
      (t) => (t.scores?.get(id) ?? 0) - Math.hypot(t.x - r.host.x, t.y - r.host.y) / 1000);
      if (shown) { emerged.add(shown); r.host = shown; r.sinceMs = nowMs; }
      this.lastSeen.set(id, { x: r.host.x, y: r.host.y, ms: nowMs });
    }
    for (const id of this.prevNamed) {
      if (named.has(id) || this.riders.has(id) || this.dead.has(id)) continue;
      const seen = this.lastSeen.get(id);
      const host = seen ? hostNear(seen, nearFor(id)) : null;
      if (host && host.id !== id) {
        this.riders.set(id, { host, sinceMs: nowMs, firstMs: nowMs });
        this.lastSeen.set(id, { x: host.x, y: host.y, ms: nowMs });
      }
    }
    this.prevNamed = named;
  }

  /**
   * Enemy tracks with no icon of their own this tick that are hidden rather
   * than gone: red ring pixels on their outline that the rings of the enemies
   * seen this tick do not account for. Returned as points for ingest().
   */
  private coveredEnemies(
    frame: CaptureFrame,
    region: { x: number; y: number; width: number; height: number },
    obs: IconObservation[],
    nowMs: number,
  ): Trace[] {
    const diam = this.iconDiam;
    const out: Trace[] = [];
    for (const t of this.tracks) {
      if (t.side !== 'enemy' || nowMs - t.seenMs > TRACK_TTL_MS || nowMs - t.observedMs > COVERED_MAX_MS) continue;
      if (obs.some((o) => o.side === 'enemy' && Math.hypot(o.x - t.x, o.y - t.y) <= diam * 0.3)) continue;
      // Rings already accounted for: every enemy seen this tick, and every
      // other enemy track it continues.
      const others = obs.filter((o) => o.side === 'enemy').map((o) => ({ x: region.x + o.x, y: region.y + o.y }));
      if (redOnOutline(frame, region.x + t.x, region.y + t.y, diam, others) < COVERED_MIN_RING_PX) continue;
      out.push({ side: 'enemy', minX: t.x, maxX: t.x, minY: t.y, maxY: t.y });
    }
    return out;
  }

  private nearestTrack(side: Side, x: number, y: number, nowMs: number): Track | null {
    let best: Track | null = null;
    let bestD = this.iconDiam * TRACK_REACH_DIAMS;
    for (const t of this.tracks) {
      if (t.side !== side || nowMs - t.seenMs > TRACK_TTL_MS) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d <= bestD) { bestD = d; best = t; }
    }
    return best;
  }
}

/**
 * What each side's icons are matched against: every player's own icons, and
 * for a player who `possesses` (Viego) while alive, also the icons of every
 * dead player of the other team. Possessing one, he is drawn with that
 * champion's icon in his own team's ring; and a dead player has no icon of
 * their own on the map, so that face in his ring's colour can only be him.
 * Once they respawn their icon stops counting as his.
 */
export function matchSets(players: HearingPlayer[], dead: Set<string>): Record<Side, TemplateSet[]> {
  const out: Record<Side, TemplateSet[]> = { ally: [], enemy: [] };
  for (const p of players) {
    let vecs = p.vecs;
    if (p.possesses && !dead.has(p.id)) {
      vecs = vecs.concat(players.filter((q) => q.side !== p.side && dead.has(q.id)).flatMap((q) => q.vecs));
    }
    if (vecs.length > 0) out[p.side].push({ id: p.id, vecs });
  }
  return out;
}

/** The item scoring highest (the first on a tie), null for none. */
function bestBy<T>(items: T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (best === null || s > bestScore) { best = item; bestScore = s; }
  }
  return best;
}

function toMap(ranked: MatchScore[]): Map<string, number> {
  return new Map(ranked.map((r) => [r.id, r.score]));
}

/** A blob that is one icon, and whether the tracker's single-icon filter
 *  took it (`strict`) or only the looser shape test here did. */
export interface LoneIcon { b: Blob; strict: boolean }

/**
 * Which blobs are icons, and how many each holds. `singles` are the ones the
 * tracker's filter took for one icon each (filterIconBlobs). That filter turns
 * down a ring filled past 40% as minions, which also turns down an icon whose
 * art is in its ring's colour — Blitzcrank's red, lone, with nobody near — so
 * an icon-shaped blob filled up to 60% is kept here as not `strict`: the
 * caller believes it only when it is recognised. `ringPx` is what one icon's
 * ring weighs in pixels.
 */
export function classifyIconBlobs(
  blobs: Blob[],
  singles: Blob[],
  diam: number,
  ringPx: number,
): { lone: LoneIcon[]; merged: Array<{ b: Blob; n: number }> } {
  const singleSet = new Set(singles);
  const lone: LoneIcon[] = [];
  const merged: Array<{ b: Blob; n: number }> = [];
  for (const b of blobs) {
    const strict = singleSet.has(b);
    const loose = !strict && isIconShaped(b, diam);
    const stacked = isStackedIcons(b, diam, ringPx);
    // A blob one icon across is one icon unless it is stacked: weight says
    // nothing more there (art in the ring's colour), so it is not consulted.
    if (isMergedIcons(b, diam) || stacked) merged.push({ b, n: Math.max(2, iconsInBlob(b, diam, ringPx)) });
    else if (strict || loose) lone.push({ b, strict });
  }
  return { lone, merged };
}

/** One icon's size and shape, filled up to 60% (filterIconBlobs stops at 40%). */
export function isIconShaped(b: Blob, diam: number): boolean {
  const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
  return bw >= diam * 0.6 && bw <= diam * 1.6 && bh >= diam * 0.6 && bh <= diam * 1.6 &&
    bw / bh >= 0.6 && bw / bh <= 1.7 && b.pixels >= 15 && b.fillRatio >= 0.08 && b.fillRatio <= 0.6;
}

/** Icons a merged blob can hold at most: a five-a-side fight. */
export const MAX_ICONS_IN_BLOB = 5;

/** A blob of several icons merged (two in lane, up to a whole team in a
 *  fight), as opposed to one icon or something that is not icons. */
export function isMergedIcons(b: Blob, diam: number): boolean {
  if (b.pixels < 15 || b.fillRatio > 0.7 || b.fillRatio < 0.08) return false;
  const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
  const span = Math.max(bw, bh) / diam;
  return Math.min(bw, bh) >= diam * 0.6 && span > 1.6 && span <= 5;
}

/**
 * Two icons stacked a few pixels apart: one blob, up to an icon and a half
 * across, wider than one icon. Weight alone is not enough to say so: an icon
 * whose art is in its ring's colour (Blitzcrank's red, Gwen's teal) weighs as
 * much as two.
 */
export function isStackedIcons(b: Blob, diam: number, ringPx: number): boolean {
  const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
  const span = Math.max(bw, bh) / diam;
  if (b.fillRatio > 0.75 || Math.min(bw, bh) < diam * 0.6 || span > 1.6) return false;
  // Wide enough that it cannot be one icon (one spans ~1.1, at most ~1.2 on
  // real minimaps) — however little ring shows, an ally's icon may cover most
  // of both — or a little wider than one and carrying two rings' worth.
  return span >= 1.3 || (span >= 1.2 && ringPx > 0 && b.pixels >= ringPx * 1.6);
}

/**
 * How many icons a merged blob holds: from how far it spans, or from how much
 * ring it carries (`ringPx`, one icon's ring in pixels) when that says more —
 * a fight piles icons up rather than out.
 */
export function iconsInBlob(b: Blob, diam: number, ringPx = 0): number {
  const span = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) / diam;
  const bySpan = span <= 1.6 ? 1 : span <= 2.1 ? 2 : 3;
  // Rounded down past half: overlapping rings share pixels, so two make
  // about 1.6 rings' worth, not 2.
  const byPixels = ringPx > 0 ? Math.floor(b.pixels / ringPx + 0.4) : 1;
  return Math.max(1, Math.min(MAX_ICONS_IN_BLOB, Math.max(bySpan, byPixels)));
}

/** Where some ring of a side shows this tick, region px. */
export interface Trace { side: Side; minX: number; maxX: number; minY: number; maxY: number }

/**
 * Red ring pixels (the tracker's enemy-border colour) on the outline of an
 * icon centred at (cx, cy) in `frame` — between 0.38 and 0.56 icon diameters
 * from the centre — leaving out any that lie on the outline of an icon centred
 * at one of `others` (their rings, give or take a few pixels of where they
 * were placed).
 */
export function redOnOutline(
  frame: CaptureFrame,
  cx: number,
  cy: number,
  diam: number,
  others: Array<{ x: number; y: number }> = [],
): number {
  const { data, width, height } = frame;
  const r0 = diam * 0.38, r1 = diam * 0.56;
  let n = 0;
  for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      const o = (y * width + x) * 4;
      if (!(data[o] > 140 && data[o + 1] < 100 && data[o + 2] < 100)) continue;
      if (others.some((p) => {
        const e = Math.hypot(x - p.x, y - p.y);
        return e >= diam * 0.25 && e <= diam * 0.7;
      })) continue;
      n++;
    }
  }
  return n;
}

function shiftBlob(b: Blob, dx: number, dy: number): Blob {
  return { ...b, cx: b.cx + dx, cy: b.cy + dy, minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy };
}
