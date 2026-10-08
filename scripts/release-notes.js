// Prints GitHub release notes for a version: a short install blurb plus that
// version's section from CHANGELOG.md. Usage: node scripts/release-notes.js 1.0.1
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) { console.error('usage: release-notes.js <version>'); process.exit(1); }

const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((l) => /^## Booru Suite/.test(l) && l.includes(version));
let section = '';
if (start !== -1) {
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  section = lines.slice(start + 1, end).join('\n').trim();
}

process.stdout.write(`**Booru Suite** — Tagger · Renamer · Tag Merger · Eagle Sync in one app.

## What it does
- **Tagger**: GPU booru tagging (PixAI v0.9, WD EVA02 v3, AnimeTimm, Merged) → \`Json/<name>.json\` per image
- **Renamer**: collision-proof unique 10-digit filenames, with full history
- **Tag Merger**: writes tags into existing Eagle items, with a confidence filter
- **Eagle Sync**: mirrors PC folders into matching Eagle folders by content
  hash, never duplicating; safety copy, byte-for-byte verification, undo

## Download
\`Booru-Suite-Setup-${version}.exe\` below (Windows). The Tagger also needs
**Python 3.9+** ([python.org](https://python.org), tick "Add to PATH"); the app
sets up its own environment on first use. NVIDIA GPUs get CUDA automatically.
Eagle Sync works best with **Eagle 4.0 Build 21+**.

Upgrading from Booru Tagger V3 / Eagle Toolkit: the first launch carries over
your Eagle Toolkit history and reuses your Tagger Python environment.

## Changes
${section || '_See CHANGELOG.md._'}

Full docs: [README](https://github.com/invictus-1/Booru-Tagging#readme)
`);
