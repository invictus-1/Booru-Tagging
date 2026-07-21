// Folder scanning, process-mode filtering (all / new / missing), and the
// processed_log.json (NDJSON) read/append — format-identical to V2 so the
// Eagle import pipeline keeps working.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const IGNORED_DIRS = new Set(['json', '$recycle.bin', 'system volume information']);

function isIgnoredDir(name) {
  return name.startsWith('.') || IGNORED_DIRS.has(name.toLowerCase());
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Read NDJSON processed_log.json into Map<normalizedImagePath, entry>
async function readLog(logFilePath) {
  const map = new Map();
  if (!(await exists(logFilePath))) return map;
  const stream = fs.createReadStream(logFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t);
      if (entry && typeof entry.imagePath === 'string') {
        map.set(path.normalize(entry.imagePath), entry);
      }
    } catch { /* skip corrupted line */ }
  }
  return map;
}

// Append entries to processed_log.json (same shape as V2:
// {success, imagePath, timestamp, status, error?})
async function appendLog(folderPath, entries) {
  if (!entries.length) return 0;
  const jsonFolder = path.join(folderPath, 'Json');
  await fsp.mkdir(jsonFolder, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(path.join(jsonFolder, 'processed_log.json'), lines, 'utf8');
  return entries.length;
}

// List image files + subfolders of one directory (non-recursive).
async function listFolder(folderPath) {
  const images = [];
  const subfolders = [];
  const dirents = await fsp.readdir(folderPath, { withFileTypes: true });
  for (const d of dirents) {
    if (d.isDirectory()) {
      if (!isIgnoredDir(d.name)) subfolders.push(path.join(folderPath, d.name));
    } else if (d.isFile() && IMAGE_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
      images.push(d.name);
    }
  }
  return { images, subfolders };
}

// Which images in this folder need processing under the given mode?
async function filterByMode(folderPath, images, mode) {
  if (mode === 'all') return images;
  const jsonFolder = path.join(folderPath, 'Json');
  const logMap = mode === 'new'
    ? await readLog(path.join(jsonFolder, 'processed_log.json'))
    : null;

  const out = [];
  for (const img of images) {
    const full = path.normalize(path.join(folderPath, img));
    const jsonPath = path.join(jsonFolder, path.basename(img, path.extname(img)) + '.json');
    if (mode === 'new') {
      const entry = logMap.get(full);
      if (!entry || entry.status !== 'success') out.push(img);
    } else if (mode === 'update') {
      // Re-tag only images that already have a JSON: refresh their tags with
      // the currently selected model (old tags are fully replaced).
      if (await exists(jsonPath)) out.push(img);
    } else { // 'missing'
      if (!(await exists(jsonPath))) out.push(img);
    }
  }
  return out;
}

// Build the full work plan: ordered list of {folderPath, images[]} covering
// root folders and (optionally) all subfolders, already mode-filtered.
async function buildPlan(rootFolders, mode, includeSubfolders, onProgress = () => {}) {
  const plan = [];
  let totalImages = 0;
  const queue = [...rootFolders];
  let scanned = 0;

  while (queue.length > 0) {
    const folder = queue.shift();
    scanned++;
    if (scanned % 10 === 0) onProgress(`Scanning... (${scanned} folders, ${totalImages} images so far)`);
    let listing;
    try {
      listing = await listFolder(folder);
    } catch (err) {
      onProgress(`Cannot read ${path.basename(folder)}: ${err.message} — skipped`);
      continue;
    }
    if (includeSubfolders) queue.push(...listing.subfolders);
    const targeted = await filterByMode(folder, listing.images, mode);
    if (targeted.length > 0) {
      plan.push({ folderPath: folder, images: targeted });
      totalImages += targeted.length;
    }
  }
  return { plan, totalImages };
}

// Stats for the UI when a folder is added — recursive, so nested folders
// are counted too (the job scan always recursed; this now matches it).
async function analyzeFolder(folderPath) {
  const result = { folderPath, imageCount: 0, jsonCount: 0, error: null };
  try {
    const queue = [folderPath];
    while (queue.length > 0) {
      const current = queue.shift();
      let listing;
      try {
        listing = await listFolder(current);
      } catch {
        continue; // unreadable subfolder — skip, keep counting the rest
      }
      queue.push(...listing.subfolders);
      result.imageCount += listing.images.length;

      const jsonFolder = path.join(current, 'Json');
      if (await exists(jsonFolder)) {
        const files = await fsp.readdir(jsonFolder);
        result.jsonCount += files.filter(
          (f) => f.toLowerCase().endsWith('.json') && f !== 'processed_log.json'
        ).length;
      }
    }
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

module.exports = { buildPlan, analyzeFolder, appendLog, IMAGE_EXTENSIONS };
