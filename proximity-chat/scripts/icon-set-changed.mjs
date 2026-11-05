#!/usr/bin/env node
/**
 * Decides whether the champion icon *set* changed in a way that warrants a
 * classifier retrain — i.e. a champion or skin was added or removed. That is the
 * only kind of change the model needs to learn.
 *
 * Exits 0 (CHANGED) if the champion/skin structure differs, or there's no
 * committed baseline yet. Exits 1 (UNCHANGED) if only icon byte-hashes or the
 * patch `version` differ.
 *
 * Why not just diff the manifest: the icon file bytes are NOT a stable
 * fingerprint. Community Dragon periodically re-encodes the PNGs (same pixels,
 * different bytes), which churns nearly every sha256 without any real icon
 * change. Keying off the champion/skin keys ignores that noise. (A genuine art
 * rework with the same skin count won't auto-trigger — run the workflow manually
 * when you know one happened.)
 *
 * Usage:
 *   node scripts/icon-set-changed.mjs                 # HEAD vs working tree
 *   node scripts/icon-set-changed.mjs OLD.json NEW.json   # explicit files (tests)
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MANIFEST = 'models/champion-icons-manifest.json';

/** Set fingerprint: {champion: [sorted skin keys]} — ignores hash VALUES + version. */
function keyset(manifest) {
  const champs = manifest.champions ?? {};
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(champs)
        .sort()
        .map((c) => [c, Object.keys(champs[c]).sort()]),
    ),
  );
}

const args = process.argv.slice(2);
let oldRaw;
let newRaw;
if (args.length === 2) {
  oldRaw = readFileSync(args[0], 'utf8');
  newRaw = readFileSync(args[1], 'utf8');
} else {
  newRaw = readFileSync(MANIFEST, 'utf8');
  const r = spawnSync('git', ['show', `HEAD:${MANIFEST}`], { encoding: 'utf8' });
  oldRaw = r.status === 0 && r.stdout ? r.stdout : null;
}

if (oldRaw === null) {
  console.log('changed: no committed manifest baseline (initial run)');
  process.exit(0);
}

if (keyset(JSON.parse(newRaw)) === keyset(JSON.parse(oldRaw))) {
  console.log('unchanged: champion/skin set identical (only icon bytes or patch version differ)');
  process.exit(1);
}

console.log('changed: champion/skin set differs (champion or skin added/removed)');
process.exit(0);
