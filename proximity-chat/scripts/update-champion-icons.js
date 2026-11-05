#!/usr/bin/env node
/**
 * Scrapes champion minimap circle icons (every skin) from Community Dragon into
 *   assets/champion-circles/<ChampionName>/<skinNum>.png
 * — the training set for the champion classifier (scripts/train_champion_classifier.py).
 *
 * Community Dragon mirrors Riot's raw game assets, so it serves the actual
 * per-skin circle icons the minimap renders. (Data Dragon only exposes square
 * loading tiles per skin, not the circle icons.) It tracks the live patch
 * automatically, so a fresh run picks up new champions, skins, and reworks.
 *
 * Also writes models/champion-icons-manifest.json — the patch version plus a
 * content hash per icon — so CI can detect when the icon set changes and a
 * retrain is due. The icons themselves are gitignored (regenerated on demand);
 * the manifest and the trained model are what get committed.
 *
 * Run: npm run update-icons                 (full scrape + prune + manifest)
 *      npm run update-icons -- --limit 8    (quick test: first 8 champions, no prune)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CD = 'https://raw.communitydragon.org/latest';
const GAME_DATA = `${CD}/plugins/rcp-be-lol-game-data/global/default/v1`;
const hudDir = (alias) => `${CD}/game/assets/characters/${alias}/hud`;
const DDRAGON_VERSIONS = 'https://ddragon.leagueoflegends.com/api/versions.json';

const ICONS_DIR = path.join(__dirname, '..', 'assets', 'champion-circles');
const MANIFEST_PATH = path.join(__dirname, '..', 'models', 'champion-icons-manifest.json');

const CONCURRENCY = 8;
const CIRCLE_RE = /_circle_(\d+)\.png$/i;
const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 0;
})();

function safeDir(name) {
  return name.replace(/[^a-zA-Z0-9 '-]/g, '_').trim();
}

async function fetchRetry(url, parse) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (parse === 'json') return r.json();
      if (parse === 'text') return r.text();
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}
const fetchJson = (url) => fetchRetry(url, 'json');
const fetchText = (url) => fetchRetry(url, 'text');
const fetchBuf = (url) => fetchRetry(url, 'buf');

/** Run async tasks with bounded concurrency. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    }),
  );
}

async function main() {
  console.log('=== Champion icon update (Community Dragon) ===\n');
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const version = (await fetchJson(DDRAGON_VERSIONS))[0];
  // Real champions have small sequential ids (currently <= ~950). Bot and
  // special-mode units live in high id blocks — e.g. Doom Bots at 66600+, whose
  // icons mimic real champions and would pollute the classifier with junk
  // near-duplicate classes. id < 10000 is a ceiling Riot won't reach for
  // centuries, so it cleanly drops those while keeping every real champion.
  let champs = (await fetchJson(`${GAME_DATA}/champion-summary.json`)).filter(
    (c) => c.id > 0 && c.id < 10000,
  );
  champs.sort((a, b) => a.name.localeCompare(b.name));
  if (argLimit) champs = champs.slice(0, argLimit);
  console.log(`Patch ${version} — ${champs.length} champions${argLimit ? ' (test subset)' : ''}\n`);

  const hashes = {}; // folder -> { skinNum -> sha }
  const expected = new Set(); // relative paths kept this run
  let done = 0;
  let downloaded = 0;
  let failed = 0;

  for (const c of champs) {
    const alias = c.alias.toLowerCase();
    const folder = safeDir(c.name);
    const champDir = path.join(ICONS_DIR, folder);
    fs.mkdirSync(champDir, { recursive: true });
    hashes[folder] = {};

    // Always pull the canonical champion circle icon as a guaranteed base
    // sample — the per-skin HUD listing sometimes omits the base (no _circle_0)
    // or is briefly unavailable for a brand-new champion.
    expected.add(path.join(folder, 'base.png'));
    try {
      const baseBuf = await fetchBuf(`${GAME_DATA}/champion-icons/${c.id}.png`);
      fs.writeFileSync(path.join(champDir, 'base.png'), baseBuf);
      hashes[folder].base = crypto.createHash('sha256').update(baseBuf).digest('hex').slice(0, 12);
      downloaded++;
    } catch (e) {
      console.error(`  x ${folder}/base.png: ${e.message}`);
      failed++;
    }

    // Per-skin circle icons from the champion's HUD directory (an HTML listing).
    let circles = [];
    try {
      const html = await fetchText(`${hudDir(alias)}/`);
      const re = new RegExp(`${alias}_circle_(\\d+)\\.png`, 'gi');
      circles = [...new Set((html.match(re) || []).map((s) => s.toLowerCase()))]
        .sort((a, b) => Number(a.match(CIRCLE_RE)[1]) - Number(b.match(CIRCLE_RE)[1]));
    } catch (e) {
      console.warn(`  ! ${c.name} (${alias}): base only, no HUD skin icons (${e.message})`);
    }

    await pool(circles, CONCURRENCY, async (file) => {
      const skinNum = file.match(CIRCLE_RE)[1];
      const rel = path.join(folder, `${skinNum}.png`);
      expected.add(rel);
      try {
        const buf = await fetchBuf(`${hudDir(alias)}/${file}`);
        fs.writeFileSync(path.join(champDir, `${skinNum}.png`), buf);
        hashes[folder][skinNum] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
        downloaded++;
      } catch (e) {
        console.error(`  x ${rel}: ${e.message}`);
        failed++;
      }
    });

    done++;
    process.stdout.write(`\r  ${done}/${champs.length} champions, ${downloaded} icons`);
  }
  console.log();

  // Prune stale dirs/files (full runs only — a --limit run must not delete the rest).
  if (!argLimit) {
    let removed = 0;
    for (const entry of fs.readdirSync(ICONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(ICONS_DIR, entry.name);
      for (const f of fs.readdirSync(dir)) {
        if (!expected.has(path.join(entry.name, f))) {
          fs.unlinkSync(path.join(dir, f));
          removed++;
        }
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    if (removed) console.log(`Cleaned ${removed} obsolete icons`);
  }

  // Deterministic, sorted manifest so CI gets clean diffs (no timestamps).
  const manifest = { source: 'communitydragon', version, champions: {} };
  for (const name of Object.keys(hashes).sort()) {
    manifest.champions[name] = {};
    for (const sk of Object.keys(hashes[name]).sort((a, b) => {
      if (a === 'base') return -1;
      if (b === 'base') return 1;
      return Number(a) - Number(b);
    })) {
      manifest.champions[name][sk] = hashes[name][sk];
    }
  }
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  const champCount = Object.keys(manifest.champions).length;
  console.log(
    `\nDone: ${downloaded} icons across ${champCount} champions` +
      (failed ? `, ${failed} file failures` : ''),
  );
  console.log(`Manifest: ${path.relative(path.join(__dirname, '..'), MANIFEST_PATH)}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
