// Shared folder walking + small fs helpers.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IGNORED_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules']);

function isIgnoredDir(name) {
  return name.startsWith('.') || IGNORED_DIRS.has(name.toLowerCase());
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Walk folders breadth-first, calling onFile(filePath) for every file.
// Respects includeSubfolders; checks shouldStop() between directories.
async function walkFiles(rootFolders, includeSubfolders, onFile, shouldStop = () => false) {
  const queue = [...rootFolders];
  while (queue.length > 0) {
    if (shouldStop()) return;
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (includeSubfolders && !isIgnoredDir(d.name)) queue.push(path.join(dir, d.name));
      } else if (d.isFile()) {
        await onFile(path.join(dir, d.name));
      }
    }
  }
}

// Append NDJSON entries to a log file.
async function appendNdjson(logPath, entries) {
  if (!entries.length) return;
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(logPath, lines, 'utf8');
}

// Read an NDJSON log into an array (missing file => []).
async function readNdjson(logPath) {
  if (!(await exists(logPath))) return [];
  const out = [];
  const content = await fsp.readFile(logPath, 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Simple async concurrency pool: run fn over items with at most `limit`
// in flight. Honors pause/cancel via control object.
async function runPool(items, limit, fn, control = {}) {
  let cursor = 0;
  const inflight = new Set();
  while (cursor < items.length || inflight.size > 0) {
    if (control.canceled) break;
    while (control.paused && !control.canceled) {
      await new Promise((r) => setTimeout(r, 150));
    }
    while (!control.paused && !control.canceled && cursor < items.length && inflight.size < limit) {
      const item = items[cursor++];
      const p = Promise.resolve(fn(item)).catch(() => {}).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }
  if (inflight.size > 0) await Promise.allSettled([...inflight]);
  return cursor; // how many were dispatched
}

module.exports = { walkFiles, appendNdjson, readNdjson, runPool, exists };
