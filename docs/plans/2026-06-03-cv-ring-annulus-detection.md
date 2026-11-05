# Ring/Annulus Champion Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Supersedes `docs/plans/2026-06-03-cv-ssim-primary-detection.md` (⛔ appearance matching proven dead — see that doc's Phase 1 outcome and memory `cv-ring-annulus-validated`).

**Goal:** Identify the local champion on the minimap by the one thing that actually separates it from clutter on real captures — its **shape**: an ally-teal **ring** enclosing a **non-teal center** (the portrait). Reject turrets (teal-*filled* centers), minion waves, and terrain. Pick "self" among ally rings via the camera-viewport box + nearest-to-predicted + temporal continuity. Stop using Data-Dragon/SSIM appearance matching for identity (it does not work on 32px real crops).

**Architecture:** Keep the existing HSV teal/red mask + connected-component `findBlobs` front-end and the camera-viewport detection. Add a pure **annulus feature** per blob: ally-teal fraction in the outer RING band minus the CENTER band, measured on the live mask around the blob center. Make annulus the **primary** champion gate (replacing the position-dominated composite + the dead template score). `center_teal` high → reject (turret). Self = the annulus-passing ally ring nearest the predicted position, seeded/anchored by the viewport box, smoothed over time.

**Tech Stack:** TypeScript (WebView2), Jest (`npx jest`), `npx tsc --noEmit`. Pure helpers in `src/services/tracking-helpers.ts`; mask/blob plumbing in `src/services/tracking.ts`. Offline validation in `scripts/annulus_separation.py` (run with `python`, not `python3`).

---

## Context

Tonight's clean-data validation (memory `cv-ring-annulus-validated`, scripts `ssim_separation.py` + `annulus_separation.py`, labels `clean_crops_labels.json`):

- **Appearance matching is dead.** SSIM(champion crop, its DDragon icon) < SSIM(terrain, icon); champion crops don't match each other (0.06) while terrain self-correlates (0.60). 32px crops are background-dominated.
- **Annulus works.** `ring_teal − center_teal`: Garen champion ring_teal **0.22** vs clutter **0.02** (`ring_teal ≥ 0.10` → 90% recall / 93% spec). Small minimap (Morde): genuine champion crops rank **#1/#2 of 45**; turrets **−0.49** (teal fills them — `center_teal` is the turret rejector). **Keep teal thresholds tight** — loosening floods the center and collapses the margin.
- Small minimap is **data-starved** (broken tracker → ~2 clean champion crops) and has occasional minion-cluster false positives → harvest more + secondary checks.

**Keep:** the shipped contamination fix (`src/scanner/*`). **Drop:** the stashed v0.4.5 (`git stash@{0}`, superseded). The 172-class classifier and the SSIM template path are no longer the identity mechanism.

## Design decisions (defaults; confirm at review)

- **D1 — Annulus is the primary champion feature.** Per candidate blob, `annulus = ringTealFrac − centerTealFrac` over radial bands *relative to the blob's own radius* (center `< 0.55r`, ring `0.70r–1.05r`). Accept as champion-candidate iff `ringTealFrac ≥ RING_MIN` AND `annulus ≥ ANN_MIN`.
- **D2 — `centerTeal` rejects turrets.** A teal-*filled* blob (turret/structure) has high centerTeal → low annulus → rejected. This is the core discriminator.
- **D3 — Tight teal thresholds.** Do NOT loosen `color-detect.ts` floors; validated to hurt.
- **D4 — Self-ID without appearance.** Among annulus-passing ally rings: (a) **seed** with the ring nearest the camera-viewport center (viewport already detected via `whiteScore`/`viewportMask`); if ambiguous, strongest annulus. (b) **follow** by nearest-to-predicted within `computeMaxJumpPx` + temporal continuity. (c) **re-seed** on loss. Rationale: observed wrong-locks were clutter, not teammates (usually elsewhere), so this is a secondary risk — but gate it (Phase 3 validation).
- **D5 — Thresholds are provisional** (tuned on ~2 small-minimap champion crops). Phase 5 harvests more clean data and re-tunes.
- **D6 — Keep the size/shape pre-filter** (`findBlobs` fillRatio band) to bound candidates; annulus does the heavy lifting.
- **D7 — Don't delete `template-match.ts`** (pure, tested, may inform future work) — just stop using it for identity.

---

## Phase 1 — Pure annulus feature (the core)

### Task 1.1: `annulusFeatures` helper

**Files:**
- Modify: `src/services/tracking-helpers.ts`
- Test: `tests/services/tracking-helpers.test.ts`

**Step 1: Write the failing tests.** Use a synthetic teal mask (1=teal) on a small grid: a RING (annulus) → high score; a FILLED disc (turret) → low/negative; EMPTY (terrain) → ~0.

```ts
import { annulusFeatures } from '../../src/services/tracking-helpers';

// Build a w×h Uint8Array; set teal(=1) where pred(x,y) is true.
function mkMask(w: number, h: number, pred: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pred(x, y)) m[y * w + x] = 1;
  return m;
}

describe('annulusFeatures', () => {
  const W = 40, H = 40, cx = 20, cy = 20, r = 12;
  const ringOf = (x: number, y: number) => {
    const d = Math.hypot(x - cx, y - cy); return d >= 0.78 * r && d <= 1.0 * r; // a thin ring at the edge
  };
  const discOf = (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r; // filled

  test('a teal RING scores strongly positive (champion)', () => {
    const f = annulusFeatures(mkMask(W, H, ringOf), W, H, cx, cy, r);
    expect(f.ringTeal).toBeGreaterThan(0.5);
    expect(f.centerTeal).toBeLessThan(0.1);
    expect(f.score).toBeGreaterThan(0.4);
  });

  test('a teal FILLED disc scores negative (turret)', () => {
    const f = annulusFeatures(mkMask(W, H, discOf), W, H, cx, cy, r);
    expect(f.centerTeal).toBeGreaterThan(0.8);
    expect(f.score).toBeLessThan(0); // center >> ring
  });

  test('empty mask scores ~0', () => {
    const f = annulusFeatures(mkMask(W, H, () => false), W, H, cx, cy, r);
    expect(f.ringTeal).toBe(0);
    expect(f.score).toBe(0);
  });
});
```

**Step 2:** `npx jest tracking-helpers -t annulusFeatures` → FAIL (not defined).

**Step 3: Implement** in `tracking-helpers.ts`:

```ts
export interface AnnulusFeatures { ringTeal: number; centerTeal: number; score: number; }

/**
 * Champion-ring signature on the teal mask, measured around a blob center.
 * A champion icon is an ally-teal RING with a non-teal portrait CENTER; a turret
 * is teal-FILLED (high center); minions/terrain have little teal in the ring.
 * Bands are relative to the icon radius r: center < 0.55r, ring 0.70r–1.05r.
 * Validated on real crops (scripts/annulus_separation.py): champion score >0,
 * turret score <0. `mask[i]===1` means teal/ally.
 */
export function annulusFeatures(
  mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number,
): AnnulusFeatures {
  const cR = 0.55 * r, inner = 0.70 * r, outer = 1.05 * r;
  const cR2 = cR * cR, in2 = inner * inner, out2 = outer * outer;
  const x0 = Math.max(0, Math.floor(cx - outer)), x1 = Math.min(w - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer)), y1 = Math.min(h - 1, Math.ceil(cy + outer));
  let cT = 0, cN = 0, rT = 0, rN = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const teal = mask[y * w + x] === 1 ? 1 : 0;
      if (d2 <= cR2) { cN++; cT += teal; }
      else if (d2 >= in2 && d2 <= out2) { rN++; rT += teal; }
    }
  }
  const ringTeal = rN ? rT / rN : 0;
  const centerTeal = cN ? cT / cN : 0;
  return { ringTeal, centerTeal, score: ringTeal - centerTeal };
}
```

**Step 4:** `npx jest tracking-helpers -t annulusFeatures` → PASS.
**Step 5: Commit** `git add -A && git commit -m "feat(cv): annulusFeatures — ring/center teal champion signature"`

### Task 1.2: Threshold constants

Add to `tracking-helpers.ts` (+ a range test): `RING_MIN` (≈0.10, from Garen 90/93 point) and `ANN_MIN` (≈0.05). Comment: provisional, re-tune in Phase 5 on more data. Commit.

---

## Phase 2 — Make annulus the primary champion gate

**Files:** Modify `src/services/tracking.ts`.

The teal mask + region already exist (`createMask` → `mask`, `region`; `findBlobs`). For each teal blob, compute `annulusFeatures(mask, region.width, region.height, b.cx, b.cy, max(bw,bh)/2)`.

### Task 2.1: Expose a per-blob annulus accessor
Add `private getAnnulus(b: Blob): AnnulusFeatures` that calls `annulusFeatures` on the **current frame's** teal mask (store `this.currentMask`/`region` at the top of the tick, like the existing score caches). No test (thin glue); covered by 1.1 + integration.

### Task 2.2: Replace template/composite identity with annulus
- In the SCANNING→LOCK and re-acquire selection (currently `pickBestBlobInRange` composite + the dead template gate ~1097–1125, ~1216–1258): filter candidate teal blobs to those with `ann.ringTeal ≥ RING_MIN && ann.score ≥ ANN_MIN`. Among survivors, pick by annulus score (primary), breaking ties by proximity to predicted (reject `> computeMaxJumpPx`).
- Remove the normalized-template `clsScore` term from the template-path composite (it's noise). Keep `computeBlobScore` for the classifier-fallback path only.
- Log the chosen blob's `ringTeal/centerTeal/score` (replaces the `ssim`/composite log) for in-game debugging.

**Verify:** `npx tsc --noEmit` clean; `npx jest` green. Commit `refactor(cv): annulus is the primary champion gate; drop dead template identity`.

---

## Phase 3 — Self-ID among ally rings (viewport + temporal)

**Files:** Modify `src/services/tracking.ts`; pure tie-break helper + test in `tracking-helpers.ts`.

### Task 3.1: `pickSelfRing` helper (pure)
Given annulus-passing ally blobs + the viewport-box center (or null) + predicted position, return the chosen blob:
- If a fresh seed (no prior lock): nearest to viewport center; if no viewport, highest annulus.
- If following: nearest to `predicted` within `maxJumpPx`; if none in range, null (→ hold/extrapolate, then re-seed).
Write TDD tests (seed-by-viewport, follow-by-proximity, out-of-range→null).

### Task 3.2: Wire it
Replace the self-selection in `handleLocked` with `pickSelfRing`, passing the viewport center (derive from `viewportMask` — add a `viewportCenter()` if not present). Commit.

**Validation (gate):** in the in-game test (Phase 5), confirm self-vs-teammate confusion is rare (log when 2+ ally rings are in range; eyeball the thumbnail). If teammates cause real mis-locks, escalate (e.g., require viewport proximity, or a one-time manual seed click — design then).

---

## Phase 4 — Clutter pre-filter tidy (small, reuse existing)

Keep `findBlobs`' fillRatio band. Optionally tighten size to `[0.6, 1.6]×expectedIconDiam` and reduce `dilate` so minion dots don't merge (validated concern from the SSIM plan Task 3.2). Each as its own TDD'd `isIconShapedBlob` helper + commit. YAGNI: only if annulus alone leaves minion-cluster false positives in-game.

---

## Phase 5 — Re-validate on more data + in-game

### Task 5.1: Build + in-game test
`npx tauri build` → stage on both machines → play one game each, **Debug ON** (clean). Pull logs + harvest. The harvest now collects far more **clean champion** crops (detection improved), especially on the small minimap.

### Task 5.2: Re-tune thresholds on the richer data
Re-run `scripts/annulus_separation.py` with freshly-labeled crops (now plentiful). Set `RING_MIN`/`ANN_MIN` from the real champion-vs-clutter distributions on BOTH minimaps. Update the constants + their comment.

### Task 5.3: Measure outcome
Compare on-champion crop rate + log "no teal blobs"/jumps vs tonight's baseline (Garen ~40% / Morde ~13%). Confirm audio works (user). 

### Task 5.4: Release decision (user-driven)
If improved: bump `src-tauri/Cargo.toml`, CHANGELOG, commit, tag, release. Real-game testing first (memory `feedback_issue_lifecycle`); user drives releases. Drop the v0.4.5 stash.

---

## Phase 6 — Remove dead identity code (after Phase 5 confirms)
Strip the template/classifier identity wiring from the hot path (keep `template-match.ts` as a pure lib). Update `docs/plans/2026-06-03-cv-tracking-research.md` + CHANGELOG to record that appearance matching was retired in favor of ring/annulus shape detection.

## Risks / open questions
- **Self-ID (D4)** is the biggest unknown — gated in Phase 3. Fallback: viewport-proximity requirement or one-time manual seed click.
- **Data starvation (small minimap)** — thresholds provisional until Phase 5 harvests more; Garen is solid.
- **Minion-cluster false positives** — a wave can form a ring-ish shape (#39 tonight); mitigate with circularity/size (Phase 4) + temporal continuity.
- **Thin ring on small minimaps** — if Phase 5 shows the small-minimap ring is too thin even with tight thresholds, consider upscaling the captured region before masking, or recommend a larger in-game minimap. Do NOT loosen teal thresholds (validated to hurt).
