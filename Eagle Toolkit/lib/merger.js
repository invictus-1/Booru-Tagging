// Tag merger: matches tag JSONs (from the booru tagger) to Eagle items by
// name and merges the tag names into each item's metadata.json.
//
// Fixes vs the old tkinter version:
//   - atomic metadata writes (temp file + rename) — a crash can no longer
//     corrupt an Eagle item
//   - optional confidence threshold: the old version merged EVERY tag in the
//     JSON including 0.1-confidence junk, which is where most "wonky" Eagle
//     tags came from. 0 = old behavior.
//   - no SQLite index to go stale: a fresh in-memory scan runs each time
//     (seconds even at 400k files). "New only" mode skips items already
//     merged, which also gives free resume after cancel.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { walkFiles, appendNdjson, readNdjson, runPool } = require('./walk');

// Extract tag names from either supported tag-file format:
//   [{"filename": ..., "tags": {"tag": 0.9, ...}}]  (autotagger / Booru Tagger V3)
//   {"tags": {...}} or {"tags": ["tag1", ...]}      (bare object)
function extractTags(tagData, threshold) {
  let tags = null;
  if (Array.isArray(tagData)) {
    for (const item of tagData) {
      if (item && typeof item === 'object' && 'tags' in item) { tags = item.tags; break; }
    }
  } else if (tagData && typeof tagData === 'object' && 'tags' in tagData) {
    tags = tagData.tags;
  }
  if (tags === null) return null;

  if (Array.isArray(tags)) return tags.filter((t) => typeof t === 'string');
  if (typeof tags === 'object') {
    return Object.entries(tags)
      .filter(([, score]) => typeof score !== 'number' || score >= threshold)
      .map(([name]) => name);
  }
  return null;
}

// Atomic JSON write: temp file in the same directory, then rename.
async function writeJsonAtomic(filePath, data) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8'); // compact, like the original
  await fsp.rename(tmp, filePath);
}

class Merger {
  constructor(processedLogPath, csvLogPath) {
    this.processedLogPath = processedLogPath;
    this.csvLogPath = csvLogPath;
  }

  // name -> [tagFilePath, ...] (a name can exist in several tag folders)
  async buildTagIndex(tagFolders, control, onLog) {
    const index = new Map();
    let count = 0;
    await walkFiles(tagFolders, true, async (f) => {
      if (!f.toLowerCase().endsWith('.json')) return;
      if (path.basename(f) === 'processed_log.json') return;
      const name = path.basename(f, path.extname(f));
      if (!index.has(name)) index.set(name, []);
      index.get(name).push(f);
      count++;
    }, () => control.canceled);
    onLog(`Tag index: ${count} tag files, ${index.size} unique names.`);
    return index;
  }

  async findMetadataFiles(metadataFolders, control) {
    const files = [];
    await walkFiles(metadataFolders, true, async (f) => {
      if (path.basename(f).toLowerCase() === 'metadata.json') files.push(f);
    }, () => control.canceled);
    return files;
  }

  async appendCsv(rows) {
    if (!rows.length) return;
    await fsp.mkdir(path.dirname(this.csvLogPath), { recursive: true });
    let out = '';
    try {
      await fsp.access(this.csvLogPath);
    } catch {
      out += 'Filepath,Name,Size,Timestamp,Updated,Tags Added\n';
    }
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const r of rows) out += r.map(esc).join(',') + '\n';
    await fsp.appendFile(this.csvLogPath, out, 'utf8');
  }

  async run({ tagFolders, metadataFolders, mode, threshold }, { onProgress, onLog, control }) {
    // 1. Tag index (fresh every run — can't go stale)
    onLog('Scanning tag folders...');
    const tagIndex = await this.buildTagIndex(tagFolders, control, onLog);
    if (control.canceled) return null;

    // 2. Metadata files
    onLog('Scanning Eagle metadata folders...');
    let metaFiles = await this.findMetadataFiles(metadataFolders, control);
    onLog(`Found ${metaFiles.length} Eagle items.`);
    if (control.canceled) return null;

    // 3. "New only": skip items already successfully merged
    if (mode === 'new') {
      const processed = new Set(
        (await readNdjson(this.processedLogPath))
          .filter((e) => e.status === 'done')
          .map((e) => path.normalize(e.filepath)),
      );
      const before = metaFiles.length;
      metaFiles = metaFiles.filter((f) => !processed.has(path.normalize(f)));
      onLog(`New-only mode: ${before - metaFiles.length} already merged, ${metaFiles.length} to process.`);
    }

    const stats = {
      total: metaFiles.length, done: 0,
      updated: 0, unchanged: 0, noMatch: 0, failed: 0, tagsAdded: 0,
    };
    const csvRows = [];
    const logEntries = [];
    const timestamp = () => new Date().toISOString();

    await runPool(metaFiles, 64, async (metaPath) => {
      try {
        const metadata = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        if (!metadata || typeof metadata !== 'object' || !('name' in metadata)) {
          stats.failed++;
          logEntries.push({ filepath: metaPath, status: 'error', error: 'no name field', at: timestamp() });
          return;
        }
        if (!Array.isArray(metadata.tags)) metadata.tags = [];

        const candidates = tagIndex.get(String(metadata.name)) || [];
        let tagNames = null;
        for (const tagFile of candidates) {
          try {
            tagNames = extractTags(JSON.parse(await fsp.readFile(tagFile, 'utf8')), threshold);
            if (tagNames !== null) break;
          } catch { /* unreadable tag file — try next candidate */ }
        }

        if (tagNames === null) {
          stats.noMatch++;
          logEntries.push({ filepath: metaPath, name: metadata.name, status: 'done', updated: false, at: timestamp() });
          csvRows.push([metaPath, metadata.name, metadata.size ?? '', timestamp(), 'False', 0]);
          return;
        }

        const current = new Set(metadata.tags);
        let added = 0;
        for (const t of tagNames) {
          if (!current.has(t)) { current.add(t); added++; }
        }

        if (added > 0) {
          metadata.tags = [...current];
          await writeJsonAtomic(metaPath, metadata);
          stats.updated++;
          stats.tagsAdded += added;
        } else {
          stats.unchanged++;
        }
        logEntries.push({ filepath: metaPath, name: metadata.name, status: 'done', updated: added > 0, addedTags: added, at: timestamp() });
        csvRows.push([metaPath, metadata.name, metadata.size ?? '', timestamp(), added > 0 ? 'True' : 'False', added]);
      } catch (err) {
        stats.failed++;
        logEntries.push({ filepath: metaPath, status: 'error', error: err.message, at: timestamp() });
        onLog(`✗ ${metaPath}: ${err.message}`);
      } finally {
        stats.done++;
        if (stats.done % 50 === 0 || stats.done === stats.total) onProgress({ ...stats });
      }
    }, control);

    await appendNdjson(this.processedLogPath, logEntries);
    await this.appendCsv(csvRows);
    onProgress({ ...stats });
    return stats;
  }
}

module.exports = { Merger, extractTags, writeJsonAtomic };
