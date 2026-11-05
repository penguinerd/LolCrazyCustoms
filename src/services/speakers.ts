// The "who is speaking" overlay, Discord style: a champion icon and
// "Summoner (Champion)" in the top-left corner of the game while that player
// talks — only players we can actually hear (in camera mode, the ones inside
// our camera box), and ourselves.
//
// This file decides who is on the list; the speakers window draws it.

/** WebRTC's per-packet voice level (0..1, 1 = 0 dBov) above which a peer is
 *  speaking: about -34 dBov, well above the noise suppression's silence. */
export const SPEAKING_LEVEL_REMOTE = 0.02;
/** Our own mic's RMS above which we are speaking (silence logs 0.000–0.005). */
export const SPEAKING_LEVEL_SELF = 0.012;
/** How long someone stays on the list after their voice drops below the
 *  level, so the list does not flicker between words. */
export const SPEAKING_HOLD_MS = 500;
/** Longest summoner name shown before it is cut with "…". */
export const MAX_NAME_CHARS = 16;

export interface SpeakerEntry {
  /** Stable key: the peer's Riot ID, or 'self'. */
  key: string;
  /** "Summoner (Champion)". */
  label: string;
  /** The champion's round minimap icon, null while unknown. */
  iconUrl: string | null;
  team: 'ally' | 'enemy';
  self: boolean;
}

/** The summoner part of a Riot ID ("Quevedo#cpev" → "Quevedo"), cut to
 *  MAX_NAME_CHARS. */
export function speakerName(riotId: string): string {
  const hash = riotId.lastIndexOf('#');
  const name = (hash > 0 ? riotId.slice(0, hash) : riotId).trim();
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS - 1) + '…' : name;
}

/** "Summoner (Champion)"; just the summoner when the champion is unknown. */
export function speakerLabel(riotId: string, championName: string): string {
  const name = speakerName(riotId);
  return championName ? name + ' (' + championName + ')' : name;
}

/**
 * Who is speaking, from voice levels sampled several times a second. A key is
 * speaking from the first loud sample until SPEAKING_HOLD_MS after its last
 * one. The list keeps the order people started speaking in, so rows do not
 * jump around while several talk at once.
 */
export class SpeakingTracker {
  private lastLoudMs = new Map<string, number>();
  private startedMs = new Map<string, number>();

  /** `levels`: this sample's level per key; a key missing from it is silent
   *  (not heard any more). Returns the keys speaking, in order. */
  update(levels: Map<string, number>, thresholdFor: (key: string) => number, nowMs: number): string[] {
    for (const [key, level] of levels) {
      if (level >= thresholdFor(key)) this.lastLoudMs.set(key, nowMs);
    }
    for (const [key, ms] of this.lastLoudMs) {
      // Not heard any more (out of the camera, muted, left): off at once.
      if (!levels.has(key) || nowMs - ms > SPEAKING_HOLD_MS) {
        this.lastLoudMs.delete(key);
        this.startedMs.delete(key);
      } else if (!this.startedMs.has(key)) {
        this.startedMs.set(key, nowMs);
      }
    }
    return [...this.startedMs.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => key);
  }

  reset(): void {
    this.lastLoudMs.clear();
    this.startedMs.clear();
  }
}
