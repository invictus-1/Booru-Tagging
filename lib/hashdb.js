// Persistent content-hash cache.
//
// Hashing is the only expensive part of a sync, so every hash is cached by
// file path and invalidated when the file's size or mtime changes. The first
// sync builds the cache; later syncs only hash new/changed files.
//
// Two hash kinds:
//   full  — SHA-256 of the entire file. Byte-identical guarantee.
//   quick — SHA-256 of size + first 256 KB + last 256 KB. Reads ≤512 KB per
//           file, so it's dramatically faster on HDDs/huge videos; for files
//           ≤512 KB it covers the whole file and equals a full check.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const QUICK_CHUNK = 256 * 1024;
const DB_VERSION = 1;

function keyOf(p) {
  // Windows paths are case-insensitive; normalize so cache hits survive casing.
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

async function fullHash(filePath, size) {
  // Small files (most images): one read is much cheaper than a stream.
  if (typeof size === 'number' && size <= 16 * 1024 * 1024) {
    return crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
  }
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function quickHash(filePath, size) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const h = crypto.createHash('sha256');
    h.update(`size:${size};`);
    if (size <= QUICK_CHUNK * 2) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      h.update(buf);
    } else {
      const head = Buffer.alloc(QUICK_CHUNK);
      const tail = Buffer.alloc(QUICK_CHUNK);
      await fh.read(head, 0, QUICK_CHUNK, 0);
      await fh.read(tail, 0, QUICK_CHUNK, size - QUICK_CHUNK);
      h.update(head);
      h.update(tail);
    }
    return 'q' + h.digest('hex');
  } finally {
    await fh.close().catch(() => {});
  }
}

class HashDb {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.entries = new Map(); // key -> { s: size, m: mtimeMs, f: full|null, q: quick|null }
    this.dirty = 0;
    this.hashedThisRun = 0;
    this.lastSave = Date.now();
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.dbPath, 'utf8'));
      if (raw && raw.v === DB_VERSION && raw.e && typeof raw.e === 'object') {
        for (const [k, v] of Object.entries(raw.e)) {
          if (Array.isArray(v)) this.entries.set(k, { s: v[0], m: v[1], f: v[2] || null, q: v[3] || null });
        }
      }
    } catch { /* missing or corrupt cache — start fresh, it's only a cache */ }
    return this.entries.size;
  }

  async save() {
    const e = {};
    for (const [k, v] of this.entries) e[k] = [v.s, v.m, v.f, v.q];
    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify({ v: DB_VERSION, e }), 'utf8');
    await fsp.rename(tmp, this.dbPath);
    this.dirty = 0;
    this.lastSave = Date.now();
  }

  // Checkpoint at most every 30 s (so a crash/cancel keeps progress) — the
  // whole cache is rewritten each time, so doing it per N files gets slow
  // on big libraries.
  async saveIfDirty() {
    if (this.dirty > 0 && !this.saving && Date.now() - this.lastSave > 30000) {
      this.saving = true;
      try { await this.save(); } finally { this.saving = false; }
    }
  }

  // Get (or compute and cache) a hash. kind: 'full' | 'quick'.
  async hash(filePath, size, mtimeMs, kind) {
    const k = keyOf(filePath);
    let e = this.entries.get(k);
    if (!e || e.s !== size || Math.floor(e.m) !== Math.floor(mtimeMs)) {
      e = { s: size, m: mtimeMs, f: null, q: null };
      this.entries.set(k, e);
    }
    const field = kind === 'full' ? 'f' : 'q';
    if (!e[field]) {
      e[field] = kind === 'full' ? await fullHash(filePath, size) : await quickHash(filePath, size);
      this.dirty++;
      this.hashedThisRun++;
    }
    return e[field];
  }

  has(filePath, size, mtimeMs, kind) {
    const e = this.entries.get(keyOf(filePath));
    if (!e || e.s !== size || Math.floor(e.m) !== Math.floor(mtimeMs)) return false;
    return Boolean(kind === 'full' ? e.f : e.q);
  }
}

module.exports = { HashDb, fullHash, quickHash, keyOf };
