'use strict';
// Builds the store package (zip) from a git ref, with exactly the files the extension
// needs, and checks it before you upload it.
//   node tools/package.js            -> dist/nextcloud_bookmark_sync-<version>.zip from HEAD
//   node tools/package.js v1.8.0     -> from that tag
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ref = process.argv[2] || 'HEAD';
// _locales/ is required: the manifest declares default_locale, without it the
// extension doesn't load at all
const FILES = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'icon48.png', 'icon128.png', 'LICENSE', '_locales'];

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

const manifest = JSON.parse(git('show', `${ref}:manifest.json`));
const version = manifest.version;
if (ref.startsWith('v') && ref !== `v${version}`) {
    throw new Error(`Tag ${ref} but manifest.json says ${version}`);
}

fs.mkdirSync(path.join(REPO, 'dist'), { recursive: true });
const zip = path.join(REPO, 'dist', `nextcloud_bookmark_sync-${version}.zip`);
fs.rmSync(zip, { force: true });
git('archive', '--format=zip', '-o', zip, ref, ...FILES);

// Every locale the manifest needs is there, with the same keys
const locales = git('ls-tree', '--name-only', `${ref}:_locales`).split('\n').filter(Boolean);
if (!locales.includes(manifest.default_locale)) throw new Error(`No _locales/${manifest.default_locale}`);
const keys = (locale) => Object.keys(JSON.parse(git('show', `${ref}:_locales/${locale}/messages.json`))).sort().join();
for (const locale of locales) {
    if (keys(locale) !== keys(manifest.default_locale)) throw new Error(`_locales/${locale} doesn't have the same keys`);
}

console.log(`${path.relative(REPO, zip)}  (version ${version}, ${Math.round(fs.statSync(zip).size / 1024)} KB, locales: ${locales.join(', ')})`);
