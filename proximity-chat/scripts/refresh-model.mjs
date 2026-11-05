#!/usr/bin/env node
/**
 * One command to refresh the champion classifier end-to-end:
 *   1. scrape the latest per-skin champion icons from Community Dragon
 *      (scripts/update-champion-icons.js)
 *   2. retrain the CNN on them and export the ONNX model + label map
 *      (scripts/train_champion_classifier.py)
 *
 * Run: npm run refresh-model                     (scrape + train)
 *      npm run refresh-model -- --skip-scrape     (retrain on existing icons)
 *      npm run refresh-model -- --limit 8         (quick test: first 8 champions)
 *
 * Python deps for the training step are in scripts/requirements.txt.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const scraper = path.join(here, 'update-champion-icons.js');
const trainer = path.join(here, 'train_champion_classifier.py');

const args = process.argv.slice(2);
const skipScrape = args.includes('--skip-scrape');
const scraperArgs = [];
const limitIdx = args.indexOf('--limit');
if (limitIdx >= 0 && args[limitIdx + 1]) scraperArgs.push('--limit', args[limitIdx + 1]);

// The train script uses repo-relative paths (assets/champion-circles, models/),
// so every child must run from the repo root regardless of the caller's cwd.
function run(cmd, cmdArgs, label) {
  console.log(`\n=== ${label} ===\n> ${cmd} ${cmdArgs.join(' ')}\n`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: repoRoot });
  if (r.error) {
    console.error(`\n✗ ${label} failed to start: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n✗ ${label} exited with code ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

/**
 * Pick a python interpreter on PATH. Among those that run, prefer one that can
 * actually `import torch` — on some machines `python3` and `python` are
 * different installs and only one has the training deps. Falls back to the
 * first that runs so the caller can emit a useful "install the deps" hint.
 */
function findPython() {
  const candidates = [];
  for (const bin of ['python3', 'python', 'py']) {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) candidates.push(bin);
  }
  if (candidates.length === 0) return null;
  for (const bin of candidates) {
    if (spawnSync(bin, ['-c', 'import torch'], { stdio: 'ignore' }).status === 0) return bin;
  }
  return candidates[0];
}

if (skipScrape) {
  console.log('Skipping scrape (--skip-scrape) — training on existing icons.');
} else {
  run(process.execPath, [scraper, ...scraperArgs], 'Scrape champion icons (Community Dragon)');
}

const python = findPython();
if (!python) {
  console.error('\n✗ No python interpreter found on PATH. Install Python 3, then:');
  console.error('    pip install -r scripts/requirements.txt');
  process.exit(1);
}
// Fail fast with a useful message if the training deps are missing.
if (spawnSync(python, ['-c', 'import torch'], { stdio: 'ignore' }).status !== 0) {
  console.error(`\n✗ '${python}' can't import torch. Install the training deps:`);
  console.error('    pip install -r scripts/requirements.txt');
  console.error('  (CPU-only: pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu)');
  process.exit(1);
}
run(python, [trainer], 'Train champion classifier');

console.log('\n✓ Model refreshed. Regenerated:');
console.log('    models/champion_classifier.onnx');
console.log('    models/champion_labels.json');
console.log('    models/champion-icons-manifest.json');
console.log('\nValidate tracking in a real game before committing or releasing the new model.');
