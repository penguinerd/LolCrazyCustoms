# SSIM-Primary Champion Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the champion's *template match* (SSIM against its real icon) the **primary** identity decision instead of a 30% term in a position-dominated composite, and stop the detector from feeding minion/turret/ward clutter into that decision — so the broadcast dot stays on the champion instead of locking onto blue clutter.

**Architecture:** Keep the existing HSV-color blob front-end and the existing (already-built, tested) `template-match.ts` SSIM toolkit. Re-wire identity selection so that, on the template path, the champion is chosen as *the blob whose raw SSIM to the local champion's icon is highest AND clears an absolute threshold*, with position used only to break ties / reject impossible jumps. Strengthen blob clutter-rejection (circularity + size, less dilation merging). Add a direct template-search fallback (no color gate) around the predicted position for frames where the thin ring isn't color-detected ("no teal blobs").

**Tech Stack:** TypeScript (browser/WebView2), Jest (`npm test`), `tsc --noEmit`. Pure CV helpers in `src/services/template-match.ts` + `tracking-helpers.ts`; wiring in `tracking.ts`. Offline validation in Python (`scripts/eval_real_crops.py`, PIL — use the `python` interpreter, not `python3`, which lacks PIL).

---

## ⛔ PHASE 1 OUTCOME (2026-06-03): FAILED — this plan is superseded

Ran the gate (`scripts/ssim_separation.py` on the clean crops). **SSIM-primary is not viable, and neither is appearance matching at all:**

- **SSIM vs Data Dragon icon is inverted:** Garen champion crops median **0.17** vs clutter (terrain/minions) **0.33**; Mordekaiser champion **−0.07** vs clutter **0.15**. Clutter matches the icon *better* than the champion. (SSIM port verified: identity=1.0, Garen-vs-Morde icon=−0.31.)
- **Self-referential (minimap-vs-minimap) also fails:** Garen champion-vs-same-champion median **0.059**, but clutter-vs-clutter **0.604**. Champion crops don't even match each other.
- **Why:** at 32px the crop is dominated by the variable background terrain around the icon (terrain is smooth + self-similar; the portrait is too small a fraction to register). No whole-crop template/appearance method can work here.

**Implication:** the v0.4 template-matching foundation (and Phases 2–5 below) are invalid. The discriminative signal must be **structural/geometric, not appearance** — detect the champion's *ring (annulus)*: an ally-colored ring enclosing a non-ally interior (the portrait). Minions are solid dots (no hole), turrets are shields, wards are eyes — the annulus signature is champion-specific and does not depend on matching the unrecognizable portrait. This is the user's "circle with contrasting content inside" idea, and it's now the only path with evidence behind it.

**Next:** a new plan around annulus/ring-shape detection, gated by its own validation (does "annulus-ness" separate champion from clutter on these same clean crops?) before any rebuild. Phases below are retained for history only.

---

## Context (why this plan exists)

This session's root-cause work (see `docs/plans/2026-06-03-cv-tracking-research.md` for the prior research, and memory `cv-debug-dot-contamination`):

1. **Fixed + shipped-locally:** the debug tracking-dot was captured into the CV input (desktop BitBlt grabbed the scanner overlay's red marker), occluding the champion icon. Removed (`src/scanner/scanner.{ts,html,css}`). Necessary but **not** the cure — clean re-test still tracked badly (Garen ~40% on-champion, Mordekaiser ~13%; logs still show frequent "no teal blobs" + cross-map jumps).

2. **The real problem, confirmed on clean data + by comparing to Quinntana's `LOL_Minimap_Tracker`:**
   - **Front-end:** we detect candidates by **ally-ring color** (`color-detect.ts` HSV mask, hue 150–215° which even reaches blue). In LoL, ally champion / minions / turrets / wards are *all* ally-colored, so color can't isolate the champion; the small-minimap tracker locks onto blue turret icons and blue minion-wave dots. Quinntana detects by **circle geometry** (radius 12–40) so minions (too small) and turrets (non-circular) are excluded for free.
   - **Decider:** Quinntana lets **SSIM decide** (threshold ~0.3). We dilute SSIM to **30%** of a composite where **position is 35%** (dominant), and we feed it the *normalized* score (best-blob=1.0) which can't judge absolute match quality. So once on a wrong blob, position pins us there and the matcher can't override. See `tracking-helpers.ts:57` and `tracking.ts:1101`.

   The SSIM matcher itself (`template-match.ts`) is already built and good. The fix is **wiring + clutter rejection**, not a new matcher.

**Stashed:** the uncommitted v0.4.5 margin-gate work is in `git stash@{0}` ("v0.4.5 margin-gate + radius-cap"). It was tuned on contaminated SSIM numbers; leave it stashed. Some of its ideas (scale-invariant gating) may be revisited in Phase 2 but re-tuned on clean data.

## Design decisions (resolve at review; defaults chosen)

- **D1 — Identity = raw SSIM to the LOCAL champion's icon, gated by an absolute threshold T.** Among detected (and clutter-filtered) teal blobs, pick the one with the highest *raw* `templateMatchScore`/`ssim` to the local champion's Data Dragon icon, provided it clears T. Position is used only to (a) break near-ties and (b) reject physically-impossible jumps — NOT as a primary score. (Replaces the composite on the template path; classifier-fallback path unchanged.)
- **D2 — Clutter rejection is geometric, not color.** Tighten `findBlobs`/filter: blob bbox ≈ icon-sized (reject too-small minion dots and too-large merged clusters), and near-circular (reject elongated minion chains / shield-shaped turrets). Reduce dilation so adjacent minion dots don't merge into icon-sized blobs.
- **D3 — Ring-dropout fallback = direct template search, no color gate.** When no blob clears T (the "no teal blobs" case), run a coarse SSIM search of the local champion's icon over a small window around the predicted/last position on the raw grayscale minimap. Accept only if it clears T. This finds the champion even when the thin ring wasn't color-masked.
- **D4 — Defer** Norfair-style multi-object tracking and full HoughCircles geometric detection. Only pursue if D1–D3 on clean data prove insufficient. (YAGNI.)
- **D5 — Threshold T is set empirically in Phase 1**, not guessed. Gate the whole plan on Phase 1: if champion SSIM does not separate from clutter SSIM on our real crops, STOP — D1 won't work and we escalate (siamese embedding / direct-search-only / geometric detection).

---

## Phase 1 — VALIDATE the premise on clean crops (de-risk gate)

> No code changes to the app. Decide whether SSIM-primary is viable before building it.

**Clean labeled crops available now (this session's clean re-test, no red dot):**
- Local Garen: `%LOCALAPPDATA%\com.proxchat.app\harvest\Garen\*.png`, the session with filename-timestamp `>= 1780472840333` (57 crops).
- `.220` Mordekaiser: `\\192.168.0.220\Users\dant123\AppData\Local\com.proxchat.app\harvest\Mordekaiser\*.png`, ts `>= 1780472850554` (45 crops).
- `.220` Ekko: same host, `harvest\Ekko\*.png` (35 crops, earlier clean-ish session — verify no red dot first).

### Task 1.1: Hand-label a champion-vs-clutter set

**Files:**
- Create: `scripts/clean_crops_labels.json`

**Step 1:** From the contact sheets already reviewed this session, list crop indices that are clearly **champion-centered** vs clearly **clutter** (turret / minion / terrain). Seed labels (verify against the actual sorted-by-timestamp file lists):
- Garen champion: 0,1,3,5,6,7,8,11,24,35,36,41,42,43,44,45,46,47,48,49,50,51 · clutter: 2,12,13,25,26,27,28,29,38,39,52,53,54,55
- Mordekaiser champion: 0,1,2,15,29,30,31 · clutter(turret): 3,5,9,10,11,12,25,26,27,28,35,36,43 · clutter(minion): 6,13,14,21,22,23,24,40,41,42
- Write as `{ "Garen": {"champion": [...], "clutter": [...]}, "Mordekaiser": {...} }`, indices into the timestamp-sorted file list of that champion's clean session.

**Step 2: Commit** `git add scripts/clean_crops_labels.json && git commit -m "test(cv): hand-labeled clean champion-vs-clutter crop set"`

### Task 1.2: Measure SSIM separation

**Files:**
- Modify/extend: `scripts/eval_real_crops.py` (read it first; it already fetches/handles icons + crops). Add a mode that, for each labeled champion:
  1. Fetch/load that champion's real icon (Data Dragon `champion/<Name>.png` or Community Dragon), circular-crop + grayscale-resize to the harvest crop size (32) exactly as `cropResizeGray` + `circularMaskIndices` do (mirror the TS so the offline number predicts in-app behavior).
  2. Compute SSIM (port `ssim` + `circularMaskIndices` from `template-match.ts`, inset 0.06) of each labeled crop vs that icon.
  3. Report distributions: champion SSIM (min/median/max) vs clutter SSIM (min/median/max), and the **best separating threshold** + its false-accept / false-reject rates.

**Step 1:** `python scripts/eval_real_crops.py --ssim-separation --labels scripts/clean_crops_labels.json`
**Expected output:** two distributions + a recommended threshold T.

**GATE / decision:**
- **PASS** (e.g., champion median SSIM ≳ 0.35 and clutter median ≲ T with a clear gap): record T, proceed to Phase 2.
- **MARGINAL** (overlap): consider per-pixel circular-mask tweaks, NCC instead of SSIM, or matching against *all 10* icons and requiring the local champ to win (not just clear T). Re-measure.
- **FAIL** (champion SSIM ≈ clutter SSIM): STOP. D1 is not viable on our data. Escalate: direct-search-only (D3 as primary), geometric circle detection, or a learned siamese embedding (research doc Phase C item 8). Bring findings back for a new plan.

**Step 2: Commit** `git add scripts/eval_real_crops.py && git commit -m "test(cv): measure SSIM champion-vs-clutter separation on clean crops"`

---

## Phase 2 — Make SSIM the primary identifier (only if Phase 1 PASSES)

### Task 2.1: Pure helper — pick the confident champion blob by raw SSIM

**Files:**
- Modify: `src/services/tracking-helpers.ts`
- Test: `tests/services/tracking-helpers.test.ts`

**Step 1: Write the failing test** (use the T from Phase 1; example uses 0.30):

```ts
import { pickChampionByTemplate } from '../../src/services/tracking-helpers';

describe('pickChampionByTemplate', () => {
  const blobs = [mkBlob(10, 10), mkBlob(200, 200)];
  test('picks the highest raw-SSIM blob above the threshold, ignoring distance', () => {
    const ssimOf = new Map([[blobs[0], 0.18], [blobs[1], 0.42]]); // far blob is the real champ
    const r = pickChampionByTemplate(blobs, b => ssimOf.get(b) ?? 0, 0.30);
    expect(r?.blob).toBe(blobs[1]);
    expect(r?.score).toBeCloseTo(0.42);
  });
  test('returns null when nothing clears the threshold (→ caller holds / dropout-search)', () => {
    const ssimOf = new Map([[blobs[0], 0.10], [blobs[1], 0.22]]);
    expect(pickChampionByTemplate(blobs, b => ssimOf.get(b) ?? 0, 0.30)).toBeNull();
  });
  test('empty input returns null', () => {
    expect(pickChampionByTemplate([], () => 1, 0.30)).toBeNull();
  });
});
```

**Step 2:** `npx jest tracking-helpers -t pickChampionByTemplate` → FAIL (not defined).

**Step 3: Implement** in `tracking-helpers.ts`:

```ts
/**
 * Identity-first selection (template path): the blob whose RAW template/SSIM
 * match to the LOCAL champion's icon is highest, provided it clears the absolute
 * acceptance threshold. Distance is NOT a factor here — identity decides, and a
 * physically-impossible jump is rejected separately by the caller. Returns null
 * when nothing matches the champion (caller holds or runs the dropout search).
 */
export function pickChampionByTemplate(
  blobs: Blob[],
  rawSsimFn: (b: Blob) => number,
  threshold: number,
): ScoredBlob | null {
  let best: ScoredBlob | null = null;
  for (const b of blobs) {
    const s = rawSsimFn(b);
    if (s < threshold) continue;
    if (!best || s > best.score) best = { blob: b, score: s };
  }
  return best;
}
```

**Step 4:** `npx jest tracking-helpers -t pickChampionByTemplate` → PASS.
**Step 5: Commit** `git add -A && git commit -m "feat(cv): pickChampionByTemplate — identity-first blob selection"`

### Task 2.2: Add the acceptance threshold constant

**Files:** Modify `src/services/tracking-helpers.ts` (+ a test asserting the value/range).

Add `export const TEMPLATE_ACCEPT_SSIM = <T from Phase 1>;` with a comment citing the Phase-1 measurement (champion vs clutter distributions). Test asserts it sits in the measured gap.
**Commit** `feat(cv): TEMPLATE_ACCEPT_SSIM acceptance threshold from clean-crop measurement`.

### Task 2.3: Wire identity-first selection into the FOLLOW loop (template path)

**Files:** Modify `src/services/tracking.ts` (the `handleLocked` Phase-1/Phase-2 selection around `pickBestBlobInRange`/`pickClassifierReacquisition`, ~1216–1258; and the SCANNING→LOCK composite at ~1097–1125).

**Approach (no new test here — covered by helper tests + integration/in-game; keep the diff minimal):**
- When `this.hasTemplates()`: select identity via `pickChampionByTemplate(tealBlobs, b => this.getTemplateRawScore(b), TEMPLATE_ACCEPT_SSIM)`. Among accepted candidates, if two are within ~0.02 SSIM, break the tie by proximity to `predicted` (keep `computeMaxJumpPx` only as an impossible-jump *reject*, not a primary score). 
- If none accepted → do NOT fall back to composite/normalized selection (that's what chased clutter). Hold/extrapolate, then Phase 4 dropout-search.
- Keep the classifier-fallback path (`!hasTemplates()`) exactly as-is.
- Remove/avoid the normalized-score composite for the template path. Leave `computeBlobScore` for the classifier path.

**Verify:** `npx tsc --noEmit` clean; `npx jest` green (existing suite). Manual reasoning: identity now decides, position only tie-breaks.
**Commit** `refactor(cv): identity-first (SSIM) selection on the template path; position only tie-breaks`.

---

## Phase 3 — Strengthen clutter rejection

### Task 3.1: Tighten the blob filter (size + circularity)

**Files:** Modify `src/services/tracking.ts` `findBlobs` filter (`~745–767`); Test: `tests/services/tracking-helpers.test.ts` (extract the predicate to a pure helper `isIconShapedBlob(blob, expectedIconDiam)` in `tracking-helpers.ts` so it's unit-testable).

**Step 1: Write failing tests** for `isIconShapedBlob`:
- rejects a too-small blob (minion dot: bbox ≪ expectedIconDiam)
- rejects a too-large blob (merged minion cluster: bbox ≫ 1.6× expectedIconDiam)
- rejects an elongated blob (minion chain: aspect ratio > ~1.6)
- accepts a ring-sized, roughly-square, low-fill blob (champion ring)

**Step 2–4:** Implement `isIconShapedBlob` (bounds on `max(bw,bh)` vs `expectedIconDiam`, aspect ratio `max/min ≤ ~1.6`, keep existing fillRatio 0.08–0.40 band), replace the inline predicate with it, run tests → PASS.
**Step 5: Commit** `feat(cv): isIconShapedBlob — reject minion dots, merged clusters, elongated chains`.

### Task 3.2: Reduce dilation merging

**Files:** Modify `src/services/tracking.ts` `dilate` (`~672`) and its call (`~1001`).

Investigate whether dilation merges adjacent minion dots into icon-sized blobs (likely cause of "merged cluster" locks). Reduce the dilation radius (or make it conditional), re-run the clean-crop eval (Phase 5) to confirm fewer clutter blobs without losing the champion ring. Keep change minimal; document why.
**Commit** `fix(cv): reduce mask dilation so minion dots don't merge into icon-sized blobs`.

---

## Phase 4 — Ring-dropout direct template search (handles "no teal blobs")

### Task 4.1: Pure helper — coarse SSIM search over a window

**Files:** Modify `src/services/template-match.ts`; Test: `tests/services/template-match.test.ts`.

**Step 1: Write failing test** `searchTemplateInWindow(grayImg, imgW, imgH, cx, cy, radius, step, iconGray, size, indices)` returns the (x,y, score) of the best SSIM match of the icon over a grid of offsets within `radius` of (cx,cy); a synthetic image with the icon planted at a known offset is found.
**Step 2–4:** Implement using existing `cropResizeGray` + `ssim` + `circularMaskIndices`; coarse grid (step ≈ 2px) then optional ±1 refine. Run → PASS.
**Step 5: Commit** `feat(cv): searchTemplateInWindow — direct icon search for color-mask dropouts`.

### Task 4.2: Wire dropout-search into the hold path

**Files:** Modify `src/services/tracking.ts` (where it currently logs "Extrapolating position (no teal blobs)").

When no teal blob clears `TEMPLATE_ACCEPT_SSIM`, before extrapolating: run `searchTemplateInWindow` over a window (radius ≈ `computeMaxJumpPx`) around the predicted position on the raw grayscale minimap. If the best score ≥ `TEMPLATE_ACCEPT_SSIM`, lock to that (x,y) instead of extrapolating. Budget the search (coarse step, capped window) to stay within the per-tick time (drop-tick guard at `tick()` already exists). 
**Verify:** `tsc` clean, suite green.
**Commit** `feat(cv): direct template search around predicted pos when the ring isn't color-detected`.

---

## Phase 5 — Re-validate (clean crops + in-game)

### Task 5.1: Offline re-measure
Re-run the Phase-1 eval against a fresh harvest after Phases 2–4 (or replay logic over existing crops where possible). Confirm on-champion rate up, clutter locks down. Record numbers in this doc.

### Task 5.2: In-game test (user)
Build (`npx tauri build` → `src-tauri/target/release/lolproxchat.exe`), stage on both machines, user plays one game each **with Debug ON** (now clean). Pull logs + harvest; rebuild contact sheets; compare "no teal blobs", jump count/magnitude, and on-champion crop rate vs this session's baseline (Garen ~40% / Morde ~13%). 

### Task 5.3: Release decision
If materially improved and audio works: bump `src-tauri/Cargo.toml`, CHANGELOG, commit, tag, release (per project release flow; **user drives releases** — do not auto-release; real-game testing first per memory `feedback_issue_lifecycle`). Decide whether the stashed v0.4.5 is still wanted (likely drop it; superseded).

---

## Deferred (YAGNI unless Phases 2–4 prove insufficient)
- Norfair-style Kalman+Hungarian multi-object tracking of all 10 icons (research doc Q3).
- Full geometric circle detection (HoughCircles-equivalent in TS/WASM) as the front-end (research doc Phase B item 5 / Quinntana's approach) — only if color-blob + `isIconShapedBlob` still leaks clutter.
- Learned siamese embedding (NCCNet-style) if plain SSIM separation is marginal (Phase 1 MARGINAL/FAIL).

## Risks / open questions
- **Phase 1 may FAIL** (SSIM doesn't separate on small minimaps) — that's the point of gating; escalate per Task 1.2.
- **Dropout search cost** — must stay within per-tick budget at ~30fps; coarse grid + capped window; measure.
- **Threshold T may differ by minimap size** — if so, scale T or normalize crop size by `expectedIconDiam` before matching (this is where the stashed v0.4.5 scale-invariance idea could return, re-tuned on clean data).
- All clean-crop numbers are from 1–3 short games on 2 machines/3 champions — widen the harvest before trusting absolute thresholds.
