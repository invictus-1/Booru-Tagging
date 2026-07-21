// Bulk image renamer: gives every image a unique random 10-digit name
// (Eagle/booru-friendly). Fixes vs the old tkinter version:
//   - collision-proof: numbers are reserved in-memory AND checked on disk,
//     not just against a database that might be stale or deleted
//   - image detection via magic bytes (fast) instead of fully opening
//     every file with PIL
//   - rename history kept as NDJSON (old name -> new name), so renames are
//     traceable/recoverable
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { walkFiles, appendNdjson, readNdjson, runPool } = require('./walk');

// Magic-byte sniffing for the formats the pipeline uses.
function sniffImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;               // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;               // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;                                  // BMP
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return true;                       // WebP
  return false;
}

async function isImageFile(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(12), 0, 12, 0);
    return bytesRead >= 12 && sniffImage(buffer);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function isTenDigitName(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  return /^\d{10}$/.test(stem);
}

class Renamer {
  constructor(historyPath) {
    this.historyPath = historyPath;
    this.reserved = new Set();     // numbers taken (history + this run)
    this.renamedPaths = new Set(); // original paths already renamed before
  }

  async loadHistory() {
    const entries = await readNdjson(this.historyPath);
    for (const e of entries) {
      if (e.newName) this.reserved.add(e.newName.split('.')[0]);
      if (e.originalPath && e.status === 'renamed') this.renamedPaths.add(path.normalize(e.originalPath));
    }
    return entries.length;
  }

  // Reserve a globally unique 10-digit number. In-memory set makes this
  // race-free within the run; disk check guards against pre-existing files
  // the history doesn't know about.
  async reserveNumber(targetDir, ext) {
    for (let attempt = 0; attempt < 10000; attempt++) {
      const num = String(crypto.randomInt(1000000000, 10000000000));
      if (this.reserved.has(num)) continue;
      this.reserved.add(num); // reserve BEFORE the async disk check — no race
      const target = path.join(targetDir, num + ext);
      try {
        await fsp.access(target);
        continue; // exists on disk — keep the reservation burned, try another
      } catch {
        return { num, target };
      }
    }
    throw new Error('Could not find a free 10-digit name (10000 attempts)');
  }

  async run({ folders, includeSubfolders }, { onProgress, onLog, control }) {
    const priorEntries = await this.loadHistory();
    if (priorEntries > 0) onLog(`Loaded rename history: ${this.reserved.size} names already taken.`);

    // Collect all candidate files first (for accurate progress).
    const files = [];
    await walkFiles(folders, includeSubfolders, async (f) => { files.push(f); }, () => control.canceled);
    onLog(`Found ${files.length} files to examine.`);

    const stats = { total: files.length, done: 0, renamed: 0, skipped: 0, failed: 0 };
    const newHistory = [];

    await runPool(files, 16, async (filePath) => {
      try {
        if (isTenDigitName(filePath)) { stats.skipped++; return; }
        if (this.renamedPaths.has(path.normalize(filePath))) { stats.skipped++; return; }
        if (!(await isImageFile(filePath))) { stats.skipped++; return; }

        const ext = path.extname(filePath).toLowerCase();
        const dir = path.dirname(filePath);
        const { num, target } = await this.reserveNumber(dir, ext);

        await fsp.rename(filePath, target);
        newHistory.push({
          originalPath: filePath,
          newName: num + ext,
          renamedOn: new Date().toISOString(),
          status: 'renamed',
        });
        stats.renamed++;
      } catch (err) {
        stats.failed++;
        onLog(`✗ ${path.basename(filePath)}: ${err.message}`);
      } finally {
        stats.done++;
        if (stats.done % 25 === 0 || stats.done === stats.total) onProgress({ ...stats });
      }
    }, control);

    // Anything not dispatched due to cancel counts as skipped.
    const undone = stats.total - stats.done;
    if (undone > 0) { stats.skipped += undone; stats.done = stats.total; }

    await appendNdjson(this.historyPath, newHistory);
    onProgress({ ...stats });
    return stats;
  }
}

module.exports = { Renamer, sniffImage, isTenDigitName };
