// Downloads champions' minimap icons from Community Dragon into
// tests/cv/fixtures-icons/<alias>/, for the camera-mode tests
// (tests/cv/camera-sim.test.ts, tests/cv/icon-identity.test.ts). The art is
// Riot's and is not committed; those tests skip when it is missing.
//
//   node scripts/fetch-minimap-icons.mjs [alias ...]
//
// With no aliases, the champions the tests use.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'cv', 'fixtures-icons');
const CDRAGON = 'https://raw.communitydragon.org/latest/game/assets/characters';
const DEFAULT = [
  'soraka', 'briar', 'syndra', 'volibear', 'kalista',
  'khazix', 'twitch', 'irelia', 'twistedfate', 'blitzcrank',
  'teemo', 'ezreal', 'olaf', 'gwen', 'lillia', 'jinx', 'leesin', 'ahri', 'garen', 'thresh',
];

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lolproxchat-tests' } });
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  return res;
}

const aliases = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;
for (const alias of aliases) {
  const dir = join(ROOT, alias);
  await mkdir(dir, { recursive: true });
  const listing = await (await get(`${CDRAGON}/${alias}/hud/`)).text();
  await writeFile(join(dir, '_listing.html'), listing);
  const files = [...new Set([...listing.matchAll(/[a-z0-9_]+_circle[a-z0-9_]*\.png/gi)].map((m) => m[0].toLowerCase()))];
  let fetched = 0;
  for (const f of files) {
    const path = join(dir, f);
    try { await access(path); continue; } catch { /* not there yet */ }
    await writeFile(path, Buffer.from(await (await get(`${CDRAGON}/${alias}/hud/${f}`)).arrayBuffer()));
    fetched++;
  }
  console.log(`${alias}: ${files.length} icons (${fetched} downloaded)`);
}
