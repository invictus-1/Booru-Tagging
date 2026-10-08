// Where Booru Suite keeps its data, and one-time migration from the two
// apps it replaces (Eagle Toolkit + Booru Tagger V3).
//
// Data root: %APPDATA%\booru-suite for BOTH `npm start` and the installed
// build (main.js pins userData), so switching between them shares the hash
// database, import ledger, run journals and saved settings.
//
// Migration copies (never moves) the old Eagle Toolkit data the first time
// the suite starts, so the old app keeps working untouched until you delete
// it yourself. The Tagger's Python environment is reused in place (see
// pythonEnv.js) rather than copied — venvs don't survive being moved.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TOOLKIT_FILES = [
  'eagle_sync_hashes.json',
  'eagle_sync_ledger.ndjson',
  'rename_history.ndjson',
  'merge_processed.ndjson',
  'processed.log',
];
const TOOLKIT_DIRS = ['eagle_sync_runs'];

function resolveDataRoot(app) {
  return app.getPath('userData');
}

// Places the old Eagle Toolkit may have kept its data.
function legacyToolkitRoots(app, appDir) {
  const appData = app.getPath('appData');
  return [
    // Booru Suite 1.0.0 run with `npm start` kept its data in its own folder.
    ...(app.isPackaged ? [] : [appDir]),
    path.join(appDir, '..', 'Eagle Toolkit'),       // dev siblings: Booru\Eagle Toolkit
    path.join(appData, 'Eagle Toolkit'),            // installed build
    path.join(appData, 'eagle-toolkit'),            // npm start without productName
  ];
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const d of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    if (d.isDirectory()) await copyDir(s, t);
    else if (d.isFile() && !(await exists(t))) await fsp.copyFile(s, t);
  }
}

// Returns a list of human-readable lines describing what was migrated.
async function migrateLegacyData(app, appDir, dataRoot) {
  const done = [];
  const marker = path.join(dataRoot, '.migrated-v2');
  if (await exists(marker)) return done;
  await fsp.mkdir(dataRoot, { recursive: true });

  for (const root of legacyToolkitRoots(app, appDir)) {
    if (path.resolve(root) === path.resolve(dataRoot)) continue;
    if (!(await exists(root))) continue;
    for (const f of TOOLKIT_FILES) {
      const src = path.join(root, f);
      const dst = path.join(dataRoot, f);
      if ((await exists(src)) && !(await exists(dst))) {
        await fsp.copyFile(src, dst);
        done.push(`${f} (from ${root})`);
      }
    }
    for (const d of TOOLKIT_DIRS) {
      const src = path.join(root, d);
      if (await exists(src)) {
        await copyDir(src, path.join(dataRoot, d));
        done.push(`${d}\\ (from ${root})`);
      }
    }
  }
  await fsp.writeFile(marker, new Date().toISOString(), 'utf8');
  return done;
}

module.exports = { resolveDataRoot, migrateLegacyData, legacyToolkitRoots };
