#!/usr/bin/env node
/**
 * Bumps the project version and updates the changelog in one shot:
 *   - src-tauri/Cargo.toml   (the [package] version)
 *   - src-tauri/Cargo.lock   (the lolproxchat package entry)
 *   - CHANGELOG.md           (new dated section under [Unreleased] + footnote link)
 *
 * Used by icon-watch.yml to turn a retrain into a release-ready PR (merging it
 * triggers release.yml via the version bump), and usable by hand for manual
 * releases. Prints the new version to stdout (nothing else on stdout).
 *
 * Run: node scripts/bump-version.mjs [--type patch|minor|major] \
 *        [--changelog "### Changed\n- ..."] [--date YYYY-MM-DD]
 *
 * Line-ending tolerant (\r?\n) so it works on a Windows checkout and on Linux CI.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'danthi123/LoLProxChat';
const CARGO_TOML = 'src-tauri/Cargo.toml';
const CARGO_LOCK = 'src-tauri/Cargo.lock';
const CHANGELOG = 'CHANGELOG.md';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const type = arg('--type', 'patch');
const body = arg('--changelog', '### Changed\n- _Describe the change._').replace(/\\n/g, '\n');
const date = arg('--date', new Date().toISOString().slice(0, 10));

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- current version from Cargo.toml ([package] version, the only line-start `version =`) ---
const toml = readFileSync(CARGO_TOML, 'utf8');
const m = toml.match(/^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"/m);
if (!m) fail(`Could not find a version in ${CARGO_TOML}`);
let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
const oldVersion = `${maj}.${min}.${pat}`;
if (type === 'major') (maj++, (min = 0), (pat = 0));
else if (type === 'minor') (min++, (pat = 0));
else pat++;
const version = `${maj}.${min}.${pat}`;
const tag = `v${version}`;

// --- Cargo.toml: replace the package version line ---
writeFileSync(CARGO_TOML, toml.replace(/^version\s*=\s*"\d+\.\d+\.\d+"/m, `version = "${version}"`));

// --- Cargo.lock: replace the version inside the lolproxchat block ---
const lock = readFileSync(CARGO_LOCK, 'utf8');
const lockRe = /(name = "lolproxchat"\r?\nversion = )"\d+\.\d+\.\d+"/;
if (!lockRe.test(lock)) fail(`Could not find the lolproxchat entry in ${CARGO_LOCK}`);
writeFileSync(CARGO_LOCK, lock.replace(lockRe, `$1"${version}"`));

// --- CHANGELOG.md: new section under [Unreleased] + footnote link ---
let cl = readFileSync(CHANGELOG, 'utf8');
const section = `## [${tag}] — ${date}\n\n${body}\n`;
if (/## \[Unreleased\]\r?\n/.test(cl)) {
  cl = cl.replace(/(## \[Unreleased\]\r?\n)/, `$1\n${section}`);
} else {
  cl = cl.replace(/(\r?\n## \[v)/, `\n${section}\n## [v`);
}
const footnote = `[${tag}]: https://github.com/${REPO}/releases/tag/${tag}`;
if (/^\[v\d+\.\d+\.\d+\]: /m.test(cl)) {
  cl = cl.replace(/^(\[v\d+\.\d+\.\d+\]: )/m, `${footnote}\n$1`);
} else {
  cl = `${cl.trimEnd()}\n\n${footnote}\n`;
}
writeFileSync(CHANGELOG, cl);

console.error(`Bumped ${oldVersion} -> ${version} (${type}); CHANGELOG dated ${date}`);
process.stdout.write(`${version}\n`);
