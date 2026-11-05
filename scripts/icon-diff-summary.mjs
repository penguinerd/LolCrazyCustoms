#!/usr/bin/env node
/**
 * Prints a Markdown summary of how the champion-icon manifest changed versus the
 * committed version (HEAD) — used to populate the body of the automated retrain
 * PR opened by .github/workflows/icon-watch.yml.
 *
 * Compares `git show HEAD:models/champion-icons-manifest.json` (old) against the
 * working-tree manifest (new). On the first run (no committed manifest yet) it
 * reports the full set as the initial baseline.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MANIFEST = 'models/champion-icons-manifest.json';

const neu = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const old = (() => {
  const r = spawnSync('git', ['show', `HEAD:${MANIFEST}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
})();

const champCount = (m) => (m?.champions ? Object.keys(m.champions).length : 0);
const iconCount = (m) =>
  m?.champions ? Object.values(m.champions).reduce((s, c) => s + Object.keys(c).length, 0) : 0;

// Advisory model-quality metrics (written by the train script) — compare the new
// model against the committed one so the PR flags any regression up front.
const METRICS = 'models/champion-classifier-metrics.json';
const tryJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const newMetrics = (() => {
  try {
    return tryJson(readFileSync(METRICS, 'utf8'));
  } catch {
    return null;
  }
})();
const oldMetrics = (() => {
  const r = spawnSync('git', ['show', `HEAD:${METRICS}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? tryJson(r.stdout) : null;
})();

const out = [];
out.push(`**Patch:** \`${neu.version}\` · **${champCount(neu)} champions** · **${iconCount(neu)} icons**`);
out.push('');

if (!old) {
  out.push('First committed manifest (baseline) — the classifier is trained on the full current icon set.');
} else {
  const oc = old.champions ?? {};
  const nc = neu.champions ?? {};
  const addedChamps = Object.keys(nc).filter((k) => !(k in oc)).sort();
  const removedChamps = Object.keys(oc).filter((k) => !(k in nc)).sort();
  const skinChanges = []; // champions that gained/lost skins (the real retrain trigger)
  let reworkedBytes = 0; // icons whose bytes changed — often just an upstream re-encode
  for (const name of Object.keys(nc)) {
    if (!(name in oc)) continue;
    const a = oc[name];
    const b = nc[name];
    const addedSkins = Object.keys(b).filter((k) => !(k in a));
    const removedSkins = Object.keys(a).filter((k) => !(k in b));
    for (const k of Object.keys(b)) if (k in a && a[k] !== b[k]) reworkedBytes++;
    if (addedSkins.length || removedSkins.length) {
      const parts = [];
      if (addedSkins.length) parts.push(`+${addedSkins.length}`);
      if (removedSkins.length) parts.push(`-${removedSkins.length}`);
      skinChanges.push(`${name} (${parts.join(', ')} skins)`);
    }
  }
  out.push(`- **New champions:** ${addedChamps.length ? addedChamps.join(', ') : 'none'}`);
  out.push(`- **Removed champions:** ${removedChamps.length ? removedChamps.join(', ') : 'none'}`);
  out.push(`- **Champions with added/removed skins:** ${skinChanges.length ? skinChanges.join('; ') : 'none'}`);
  if (reworkedBytes) {
    out.push('');
    out.push(
      `_(${reworkedBytes} existing icons had byte-level changes — usually an upstream Community Dragon re-encode, not a content change; this alone does not trigger a retrain.)_`,
    );
  }
}

if (newMetrics) {
  const line = (label, key) => {
    const n = newMetrics[key];
    if (n == null) return null;
    const o = oldMetrics?.[key];
    const delta = o != null ? ` (prev ${o}, ${n - o >= 0 ? '+' : ''}${(n - o).toFixed(2)})` : '';
    return `- ${label}: **${n}**${delta}`;
  };
  const lines = [
    line('self-vs-4 — your icon out-scoring 4 random others (≈ picking yourself among 5 allies)', 'self_vs_4'),
    line('top-1', 'top1'),
    line('top-5', 'top5'),
  ].filter(Boolean);
  if (lines.length) {
    out.push('');
    out.push(`**Model quality** (held-out val${newMetrics.val_samples ? `, ${newMetrics.val_samples} samples` : ''}):`);
    out.push(...lines);
    if (!oldMetrics) {
      out.push('_(baseline — no prior model metrics to compare against)_');
    } else if (
      newMetrics.self_vs_4 != null &&
      oldMetrics.self_vs_4 != null &&
      newMetrics.self_vs_4 < oldMetrics.self_vs_4 - 0.01
    ) {
      out.push('⚠️ **self-vs-4 regressed vs the live model** — scrutinize tracking carefully before merging.');
    }
  }
}

out.push('');
out.push('---');
out.push('');
out.push(
  '⚠️ **Validate tracking in a real game before merging** — the classifier is load-bearing for tracking quality, and per-class accuracy varies by icon.',
);
out.push('');
out.push(
  'This PR already bumps the patch version + CHANGELOG, so **merging it triggers `release.yml`** automatically — it builds the Windows exe and opens a **draft** release for you to review and publish.',
);

console.log(out.join('\n'));
