// Eagle Sync: one-way PC -> Eagle mirror that never duplicates.
//
// How it decides "already in Eagle":
//   1. Size pre-filter. Two files can only be identical if their sizes match,
//      so files whose size doesn't occur on the other side are known-new
//      without reading a byte.
//   2. Content hash (SHA-256, cached in eagle_sync_hashes.json) for every
//      size collision — on both the PC side and the Eagle side.
//   3. A ledger of everything this tool has ever imported (by hash). Items you
//      later delete from Eagle are NOT re-imported unless you ask for it, and
//      the ledger guards against duplicates even if Eagle's stored copy were
//      ever to differ from the source.
//
// Imports go through Eagle's own local API (Eagle copies the file into its
// library). The source file is never touched, and deleting in Eagle never
// affects your PC folders. The first batch is checked to make sure every
// source file still exists — the run aborts if not.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { EagleClient, indexFolders, normKey, segKey } = require('./eagleApi');
const { HashDb, fullHash } = require('./hashdb');
const { appendNdjson, readNdjson, runPool } = require('./walk');
const { extractTags } = require('./merger');

const TYPE_EXTS = {
  images: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'svg'],
  gifs: ['gif', 'apng'],
  videos: ['webm', 'mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'flv'],
};

const SKIP_DIR_NAMES = new Set(['json', '$recycle.bin', 'system volume information', 'node_modules', 'eagle sync backup']);
const BACKUP_DIR_NAME = 'Eagle Sync Backup';
const IMPORT_BATCH = 50;

function buildExtSet(types = {}, extra = '') {
  const set = new Set();
  for (const [k, list] of Object.entries(TYPE_EXTS)) if (types[k]) list.forEach((e) => set.add(e));
  for (const e of String(extra || '').split(/[\s,;]+/)) {
    const t = e.trim().replace(/^\./, '').toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

function skipDir(name) {
  const n = name.toLowerCase();
  return n.startsWith('.') || SKIP_DIR_NAMES.has(n) || n.endsWith('.library');
}

// The media file inside an Eagle item folder (<id>.info/<name>.<ext>).
async function resolveEagleFile(imagesDir, it) {
  const dir = path.join(imagesDir, `${it.id}.info`);
  if (it.name && it.ext) {
    const direct = path.join(dir, `${it.name}.${it.ext}`);
    try { const st = await fsp.stat(direct); return { p: direct, st }; } catch { /* fall through */ }
  }
  let best = null;
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!d.isFile() || d.name === 'metadata.json' || /_thumbnail\.png$/i.test(d.name)) continue;
    const p = path.join(dir, d.name);
    const st = await fsp.stat(p);
    if (!best || st.size > best.st.size) best = { p, st };
  }
  if (!best) throw new Error('no media file');
  return best;
}

function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

// Windows-safe folder name for a backup path segment.
function safeSeg(s) {
  return String(s).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '_';
}

// Minimal CSV line parser (handles quotes) for manifest updates.
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const csvEsc = (v) => {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// Walk one source root, returning files with their path relative to the root.
async function walkSource(root, extSet, control, skipPaths = new Set()) {
  const out = [];
  const queue = [{ dir: root, rel: [] }];
  while (queue.length) {
    if (control.canceled) return out;
    const { dir, rel } = queue.shift();
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (d.isDirectory()) {
        const full = path.join(dir, d.name);
        if (!skipDir(d.name) && !skipPaths.has(path.resolve(full).toLowerCase())) queue.push({ dir: path.join(dir, d.name), rel: [...rel, d.name] });
      } else if (d.isFile()) {
        const ext = path.extname(d.name).slice(1).toLowerCase();
        if (extSet.has(ext)) {
          out.push({ path: path.join(dir, d.name), dir, rel, ext, stem: path.basename(d.name, path.extname(d.name)) });
        }
      }
    }
  }
  return out;
}

class EagleSync {
  constructor(dataRoot) {
    this.hashDbPath = path.join(dataRoot, 'eagle_sync_hashes.json');
    this.ledgerPath = path.join(dataRoot, 'eagle_sync_ledger.ndjson');
    this.runsDir = path.join(dataRoot, 'eagle_sync_runs');
    this.plan = null;
  }

  // Quick connectivity check for the UI's status line.
  static async status(opts = {}) {
    const client = new EagleClient({ base: opts.apiBase || undefined, token: opts.token || '' });
    try {
      const version = await client.detect();
      const lib = await client.libraryInfo();
      return {
        ok: true,
        api: version,
        eagleVersion: client.appInfo?.version || null,
        build: client.appInfo?.buildVersion || null,
        libraryPath: lib.path,
        libraryName: lib.name || (lib.path ? path.basename(lib.path) : null),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------
  // Scan: builds the plan, changes nothing.
  // ---------------------------------------------------------------------
  async scan(opts, { onProgress, onLog, control }) {
    this.plan = null;
    const kind = opts.matchMode === 'quick' ? 'quick' : 'full';
    const progress = (phase, done, total, extra = {}) => onProgress({ phase, done, total, ...extra });

    // 1. Eagle connection + library
    const client = new EagleClient({ base: opts.apiBase || undefined, token: opts.token || '' });
    await client.detect();
    const lib = await client.libraryInfo();
    let libPath = lib.path;
    if (!libPath) {
      if (!opts.libraryPath) throw new Error('This Eagle version doesn\'t report its library path — set it manually under Advanced.');
      libPath = opts.libraryPath;
    } else if (opts.libraryPath && path.normalize(opts.libraryPath).toLowerCase() !== path.normalize(libPath).toLowerCase()) {
      onLog(`Note: Eagle has "${libPath}" open; using that instead of the manual path.`, 'warning');
    }
    const imagesDir = path.join(libPath, 'images');
    try { await fsp.access(imagesDir); } catch {
      throw new Error(`Eagle library images folder not found: ${imagesDir}`);
    }
    onLog(`Eagle ${client.appInfo?.version || ''} (API ${client.version}) · library: ${libPath}`);
    if (!client.canFileExisting && opts.fileExisting) {
      onLog('Older Eagle API: can\'t file existing items into folders — that option is skipped. Update Eagle to 4.0 Build 21+ for it.', 'warning');
    }

    const folders = indexFolders(lib.folders);
    onLog(`Eagle folders: ${folders.byId.size}.`);

    // 2. Eagle items: API listing + disk listing (disk catches trashed items
    //    and anything the API omits).
    const items = new Map(); // id -> { id, name, ext, size, folders, isDeleted }
    progress('Reading Eagle items', 0, 0);
    await client.listItems(async (page) => {
      for (const it of page) {
        if (!it || !it.id) continue;
        items.set(it.id, {
          id: it.id, name: it.name, ext: it.ext, size: Number(it.size) || 0,
          folders: Array.isArray(it.folders) ? it.folders : [], isDeleted: Boolean(it.isDeleted),
        });
      }
      progress('Reading Eagle items', items.size, 0);
    }, () => control.canceled);
    if (control.canceled) return null;

    let infoDirs = [];
    try {
      infoDirs = (await fsp.readdir(imagesDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name.endsWith('.info'))
        .map((d) => d.name.slice(0, -5));
    } catch (err) {
      throw new Error(`Can't read ${imagesDir}: ${err.message}`);
    }
    const onDisk = new Set(infoDirs);
    const extraIds = infoDirs.filter((id) => !items.has(id));
    if (extraIds.length) {
      await runPool(extraIds, 32, async (id) => {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(imagesDir, `${id}.info`, 'metadata.json'), 'utf8'));
          items.set(id, {
            id, name: m.name, ext: m.ext, size: Number(m.size) || 0,
            folders: Array.isArray(m.folders) ? m.folders : [], isDeleted: Boolean(m.isDeleted),
          });
        } catch { /* half-written or foreign folder — ignore */ }
      }, control);
    }
    const apiCount = items.size - extraIds.filter((id) => items.has(id)).length;
    for (const id of [...items.keys()]) if (!onDisk.has(id)) items.delete(id);
    const trashed = [...items.values()].filter((i) => i.isDeleted).length;
    onLog(`Eagle items: ${items.size}${trashed ? ` (${trashed} in Eagle's trash)` : ''} · API listed ${apiCount}, item folders on disk ${infoDirs.length}.`);
    if (control.canceled) return null;

    // 3. PC files
    const extSet = buildExtSet(opts.types, opts.extraExts);
    if (!extSet.size) throw new Error('No file types selected.');
    // A folder inside another added folder would be walked twice and mapped
    // to two different Eagle folders — keep only the outermost.
    const lowerRes = (p0) => path.resolve(p0).toLowerCase();
    const sources = [];
    for (const src of opts.sources) {
      const a = lowerRes(src);
      const withSep = (x) => (x.endsWith(path.sep) ? x : x + path.sep);
      const covered = opts.sources.some((other) => {
        const b = lowerRes(other);
        return b !== a && withSep(a).startsWith(withSep(b));
      });
      if (covered) { onLog(`Skipping "${src}" — it's inside another folder you added, so it's already covered.`, 'warning'); continue; }
      if (sources.some((x) => lowerRes(x) === a)) continue;
      sources.push(src);
    }
    const pcFiles = [];
    for (const root of sources) {
      progress('Scanning PC folders', pcFiles.length, 0);
      const skipPaths = new Set([path.resolve(libPath).toLowerCase()]);
      if (opts.backupDir && opts.backupDir.trim()) skipPaths.add(path.resolve(opts.backupDir.trim()).toLowerCase());
      const found = await walkSource(root, extSet, control, skipPaths);
      for (const f of found) f.root = root;
      for (const f of found) pcFiles.push(f); // no spread: huge arrays overflow the call stack
      if (control.canceled) return null;
    }
    let statDone = 0;
    await runPool(pcFiles, 32, async (f) => {
      try {
        const st = await fsp.stat(f.path);
        f.size = st.size; f.mtimeMs = st.mtimeMs;
      } catch { f.size = -1; }
      if (++statDone % 500 === 0) progress('Scanning PC folders', statDone, pcFiles.length);
    }, control);
    if (control.canceled) return null;
    const files = pcFiles.filter((f) => f.size > 0);
    onLog(`PC files: ${files.length} matching the selected types.`);

    // 4. Ledger
    const ledger = await readNdjson(this.ledgerPath);
    const ledgerHashes = new Set();
    const ledgerSizes = new Set();
    // An import only counts as "you deleted it from Eagle" once it was
    // confirmed to exist in Eagle (verified). Imports Eagle never finished
    // writing (closed/crashed mid-import) are treated as not imported.
    const verifiedIds = new Set();
    for (const e of ledger) if (e.verifiedId) verifiedIds.add(e.verifiedId);
    for (const e of ledger) {
      if (e.verifiedId) continue;
      if (e.pending && !(e.eagleId && verifiedIds.has(e.eagleId))) continue;
      if (e.full) ledgerHashes.add(e.full);
      if (e.quick) ledgerHashes.add(e.quick);
      if (e.size) ledgerSizes.add(e.size);
    }

    // 5. Decide what needs hashing (size collisions only)
    const eagleBySize = new Map();
    for (const it of items.values()) {
      if (!eagleBySize.has(it.size)) eagleBySize.set(it.size, []);
      eagleBySize.get(it.size).push(it);
    }
    const pcSizeCount = new Map();
    for (const f of files) pcSizeCount.set(f.size, (pcSizeCount.get(f.size) || 0) + 1);

    const pcToHash = files.filter((f) =>
      eagleBySize.has(f.size) || ledgerSizes.has(f.size) || pcSizeCount.get(f.size) > 1);
    const eagleToHash = [...items.values()].filter((it) => pcSizeCount.has(it.size));

    const db = new HashDb(this.hashDbPath);
    const cached = await db.load();
    onLog(`Hash database: ${cached} cached entries. To verify: ${pcToHash.length} PC files, ${eagleToHash.length} Eagle items (size matches only).`);

    const hashTotal = pcToHash.length + eagleToHash.length;
    let hashDone = 0;
    let hashErrors = 0;
    const tick = () => {
      hashDone++;
      if (hashDone % 25 === 0 || hashDone === hashTotal) {
        progress('Hashing', hashDone, hashTotal, { hashedNew: db.hashedThisRun });
      }
    };
    progress('Hashing', 0, hashTotal);
    const eagleFailedSizes = new Set(); // sizes we can't vouch for on the Eagle side
    await runPool(eagleToHash, 8, async (it) => {
      try {
        const { p, st } = await resolveEagleFile(imagesDir, it);
        it.hash = await db.hash(p, st.size, st.mtimeMs, kind);
      } catch { hashErrors++; eagleFailedSizes.add(it.size); }
      tick();
      await db.saveIfDirty();
    }, control);
    await runPool(pcToHash, 8, async (f) => {
      try { f.hash = await db.hash(f.path, f.size, f.mtimeMs, kind); } catch { hashErrors++; f.hashFailed = true; }
      tick();
      await db.saveIfDirty();
    }, control);
    await db.save();
    if (control.canceled) return null;
    if (hashErrors) onLog(`${hashErrors} file(s) couldn't be read for hashing. Anything that can't be ruled out as a duplicate is left out of this import (shown as "couldn't verify") — scan again later.`, 'warning');
    onLog(`Hashing done: ${db.hashedThisRun} newly hashed, rest from cache.`);

    const eagleByHash = new Map();
    for (const it of eagleToHash) {
      if (!it.hash) continue;
      if (!eagleByHash.has(it.hash)) eagleByHash.set(it.hash, []);
      eagleByHash.get(it.hash).push(it);
    }

    // 6. Folder rows + classification
    // Exact path only (case-insensitive). No "same name somewhere else"
    // guessing: with thousands of folders, generic names like "Sprites" or
    // "Fanart" make that unsafe. Anything not found at its exact path is shown
    // as missing and only created (under its deepest existing ancestor) after
    // you approve it.
    const resolve = (segs) => {
      const hit = folders.byPath.get(segKey(segs));
      return hit ? { entry: hit, how: 'path' } : null;
    };
    // For a missing folder: the deepest existing ancestor to create under.
    const creationBase = (segs) => {
      for (let k = segs.length - 1; k >= 1; k--) {
        const r = resolve(segs.slice(0, k));
        if (r) return { baseId: r.entry.id, basePath: r.entry.path, baseSegs: r.entry.segs, rest: segs.slice(k) };
      }
      return { baseId: null, basePath: '', baseSegs: [], rest: segs };
    };
    const rows = new Map(); // key -> row
    const rowFor = (f) => {
      let segs;
      if (opts.mapping === 'children') segs = [...f.rel];
      else segs = [path.basename(f.root), ...f.rel];
      segs = segs.map((s) => s.trim()).filter(Boolean);
      const eaglePath = segs.join('/');
      const key = normKey(eaglePath);
      if (!rows.has(key)) {
        let folderId = null;
        let match = 'unfiled';
        let create = null;
        if (segs.length) {
          const r = resolve(segs);
          if (r) { folderId = r.entry.id; match = r.how; } else {
            match = 'missing';
            create = creationBase(segs);
          }
        }
        rows.set(key, {
          key, eaglePath, segs, folderId, match, create,
          createPath: create ? [create.basePath, ...create.rest].filter(Boolean).join('/') : null,
          matchedPath: folderId ? folders.byId.get(folderId)?.path : null,
          sourceDirs: new Set(),
          newFiles: [], inPlace: 0, elsewhere: [], inTrash: 0, deleted: 0, dupOnPc: 0, unverified: 0,
        });
      }
      return rows.get(key);
    };

    const seenNew = new Set();
    for (const f of files) {
      const row = rowFor(f);
      row.sourceDirs.add(f.dir);
      const matches = f.hash ? eagleByHash.get(f.hash) : null;
      // Couldn't hash it, or an Eagle file of the same size couldn't be read:
      // it might already be in Eagle, so never import it blind.
      if (f.hashFailed || (!(matches && matches.length) && eagleFailedSizes.has(f.size))) { row.unverified++; continue; }
      if (matches && matches.length) {
        const live = matches.filter((m) => !m.isDeleted);
        if (live.length && row.match === 'unfiled') row.inPlace++; // no target folder: being in Eagle is enough
        else if (live.some((m) => row.folderId && m.folders.includes(row.folderId))) row.inPlace++;
        else if (live.length) row.elsewhere.push({ itemId: live[0].id, file: f.path });
        else row.inTrash++;
        continue;
      }
      if (f.hash && ledgerHashes.has(f.hash) && !opts.restoreDeleted) { row.deleted++; continue; }
      if (f.hash) {
        if (seenNew.has(f.hash)) { row.dupOnPc++; continue; }
        seenNew.add(f.hash);
      }
      row.newFiles.push(f);
    }

    const rowList = [...rows.values()].sort((a, b) => a.eaglePath.localeCompare(b.eaglePath));
    // Folders with nothing to do are still listed (so you can see they matched),
    // but only rows with work are selected by default.
    for (const r of rowList) {
      r.hasWork = r.newFiles.length > 0 || (opts.fileExisting && client.canFileExisting && r.elsewhere.length > 0);
    }

    this.plan = {
      createdAt: Date.now(), opts, kind, libPath, imagesDir,
      apiBase: opts.apiBase, token: opts.token, apiVersion: client.version,
      rows: rowList,
    };
    const summary = this.summarize();
    onLog(`Plan: ${summary.totals.newFiles} new · ${summary.totals.inPlace} already in place · ${summary.totals.elsewhere} in another Eagle folder · ${summary.totals.missingFolders} folder(s) missing in Eagle${summary.totals.unverified ? ` · ${summary.totals.unverified} couldn't be verified (left out)` : ''}.`, 'success');
    return summary;
  }

  // Serializable view of the plan for the renderer.
  summarize() {
    const p = this.plan;
    if (!p) return null;
    const totals = { newFiles: 0, inPlace: 0, elsewhere: 0, inTrash: 0, deleted: 0, dupOnPc: 0, unverified: 0, missingFolders: 0, rows: p.rows.length };
    const rows = p.rows.map((r) => {
      totals.newFiles += r.newFiles.length;
      totals.inPlace += r.inPlace;
      totals.elsewhere += r.elsewhere.length;
      totals.inTrash += r.inTrash;
      totals.deleted += r.deleted;
      totals.dupOnPc += r.dupOnPc;
      totals.unverified += r.unverified;
      if (r.match === 'missing') totals.missingFolders++;
      return {
        key: r.key, eaglePath: r.eaglePath || '(no folder — unfiled)', match: r.match, matchedPath: r.matchedPath,
        createPath: r.createPath,
        sourceDirs: r.sourceDirs.size,
        newFiles: r.newFiles.length, inPlace: r.inPlace, elsewhere: r.elsewhere.length,
        inTrash: r.inTrash, deleted: r.deleted, dupOnPc: r.dupOnPc, unverified: r.unverified,
        hasWork: r.hasWork,
      };
    });
    return { rows, totals, apiVersion: p.apiVersion, libPath: p.libPath, canFileExisting: p.apiVersion === 'v2' };
  }

  // ---------------------------------------------------------------------
  // Execute: creates folders, files existing items, imports new files.
  // selected: row keys to act on. createKeys: missing-folder rows the user
  // approved creating (missing rows not approved are skipped).
  // ---------------------------------------------------------------------
  async execute({ selected, createKeys, overrides }, { onProgress, onLog, control }) {
    const p = this.plan;
    if (!p) throw new Error('Scan first.');
    if (Date.now() - p.createdAt > 6 * 60 * 60 * 1000) throw new Error('Plan is over 6 hours old — scan again.');
    const sel = new Set(selected);
    const create = new Set(createKeys || []);
    // Options that don't change the plan can be adjusted between Scan and Import.
    const o = overrides || {};
    const opts = { ...p.opts };
    for (const k of ['attachTags', 'threshold', 'safetyCopy', 'backupDir']) if (o[k] !== undefined) opts[k] = o[k];

    const client = new EagleClient({ base: p.apiBase || undefined, token: p.token || '' });
    await client.detect();
    const lib = await client.libraryInfo();
    if (lib.path && path.normalize(lib.path).toLowerCase() !== path.normalize(p.libPath).toLowerCase()) {
      throw new Error(`Eagle switched libraries since the scan (now "${lib.path}"). Scan again.`);
    }
    const folders = indexFolders(lib.folders);

    const rows = p.rows.filter((r) => sel.has(r.key) && (r.match !== 'missing' || create.has(r.key)));
    const stats = {
      total: rows.reduce((n, r) => n + r.newFiles.length, 0), done: 0,
      imported: 0, filed: 0, foldersCreated: 0, failed: 0,
      verified: 0, mismatched: 0, backedUp: 0, backupDir: null,
    };
    const progress = (phase) => onProgress({ phase, ...stats });
    const waitIfPaused = async () => {
      while (control.paused && !control.canceled) await new Promise((res) => setTimeout(res, 150));
    };

    // Check space for the safety copy BEFORE changing anything in Eagle.
    const backupBase = (opts.backupDir && opts.backupDir.trim())
      || path.join(path.dirname(path.resolve(opts.sources[0])), BACKUP_DIR_NAME);
    const needBytes = rows.reduce((n, r) => n + r.newFiles.reduce((m, f) => m + f.size, 0), 0);
    if (opts.safetyCopy && needBytes > 0) {
      await fsp.mkdir(backupBase, { recursive: true });
      let free = null;
      try { const sf = await fsp.statfs(backupBase); free = Number(sf.bavail) * Number(sf.bsize); } catch { /* statfs unsupported */ }
      if (free !== null && free < needBytes * 1.05 + 512 * 1024 * 1024) {
        throw new Error(`Not enough free space for the safety copy: need ~${(needBytes / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB free at ${backupBase}. Pick another backup folder, or untick Safety copy. Nothing was changed.`);
      }
    }

    // Run journal: every change this run makes to Eagle, so it can be undone.
    await fsp.mkdir(this.runsDir, { recursive: true });
    const journalPath = path.join(this.runsDir, `${stamp()}.ndjson`);
    const journal = (entries) => appendNdjson(journalPath, Array.isArray(entries) ? entries : [entries]);
    await journal({ type: 'run', at: new Date().toISOString(), libPath: p.libPath, sources: opts.sources });

    // 1. Create missing folders (parents first), re-resolving against the
    //    live tree in case you created some by hand since the scan.
    const ensurePath = async ({ baseId, basePath, rest }) => {
      if (baseId && !folders.byId.has(baseId)) throw new Error(`parent folder "${basePath}" no longer exists in Eagle`);
      let parentId = baseId;
      const segs = baseId ? [...folders.byId.get(baseId).segs] : []; // live position of the parent
      for (const seg of rest) {
        segs.push(seg);
        const soFar = segs.join('/');
        const hit = folders.byPath.get(segKey(segs));
        if (hit) { parentId = hit.id; continue; }
        const id = await client.createFolder(seg, parentId);
        if (!id) throw new Error('Eagle returned no folder id');
        await journal({ type: 'folderCreated', id, path: soFar, parentId });
        const entry = { id, path: soFar, segs: [...segs], name: seg };
        folders.byPath.set(segKey(segs), entry);
        folders.byId.set(id, entry);
        stats.foldersCreated++;
        onLog(`✚ Created Eagle folder: ${soFar}`, 'success');
        parentId = id;
      }
      return parentId;
    };
    for (const r of rows) {
      await waitIfPaused();
      if (control.canceled) break;
      if (r.match === 'missing') {
        try {
          r.folderId = await ensurePath(r.create);
        } catch (err) {
          onLog(`✗ Couldn't create "${r.eaglePath}": ${err.message} — skipping that folder.`, 'error');
          r.skip = true;
        }
      }
    }
    progress('Creating folders');

    // 2. File existing Eagle items into their matching folder (no copies made).
    if (opts.fileExisting && client.canFileExisting) {
      const additions = new Map(); // itemId -> Set(folderId)
      for (const r of rows) {
        if (r.skip || !r.folderId) continue;
        for (const e of r.elsewhere) {
          if (!additions.has(e.itemId)) additions.set(e.itemId, new Set());
          additions.get(e.itemId).add(r.folderId);
        }
      }
      const ids = [...additions.keys()];
      for (let i = 0; i < ids.length && !control.canceled; i += 200) {
        await waitIfPaused();
        if (control.canceled) break;
        const chunk = ids.slice(i, i + 200);
        let current = [];
        try { current = await client.getItems(chunk); } catch (err) {
          onLog(`✗ Couldn't read items to file them: ${err.message}`, 'error');
          stats.failed += chunk.length;
          continue;
        }
        const byId = new Map(current.map((it) => [it.id, it]));
        for (const id of chunk) {
          const it = byId.get(id);
          if (!it) { stats.failed++; continue; }
          const before = it.folders || [];
          const added = [...additions.get(id)].filter((f) => !before.includes(f));
          if (!added.length) continue;
          try {
            await client.setItemFolders(id, [...before, ...added]);
            await journal({ type: 'filed', itemId: id, added, before });
            stats.filed++;
          } catch (err) {
            stats.failed++;
            onLog(`✗ Couldn't file item ${id}: ${err.message}`, 'error');
          }
        }
        progress('Filing existing items');
      }
      if (stats.filed) onLog(`Filed ${stats.filed} existing Eagle item(s) into their matching folders.`, 'success');
    }

    // 3. Import new files.
    const db = new HashDb(this.hashDbPath);
    await db.load();
    let firstBatchChecked = false;
    let verifyFolders = client.version === 'v2';
    const importable = rows.filter((r) => !r.skip && (r.match === 'unfiled' || r.folderId));
    const imported = []; // { id, full, src, importPath } for the final verification pass

    // Safety copy: copy every new file into a dated backup folder first and
    // import FROM the copy. Eagle never touches your originals, and the backup
    // is a complete set of what went in until you delete it.
    let runDir = null;
    let manifest = null;
    if (opts.safetyCopy && importable.some((r) => r.newFiles.length) && !control.canceled) {
      runDir = path.join(backupBase, stamp());
      await fsp.mkdir(runDir, { recursive: true });
      manifest = path.join(runDir, 'manifest.csv');
      await fsp.writeFile(manifest, 'Original,Backup copy,Eagle folder,Eagle item id,SHA-256,Verified in Eagle\n', 'utf8');
      stats.backupDir = runDir;
      onLog(`Safety copy on: new files are copied to "${runDir}" and imported from there. Originals are never handed to Eagle.`, 'success');
    }
    const usedBackupNames = new Set();
    const backupPathFor = (r, f) => {
      const dir = path.join(runDir, ...(r.segs.length ? r.segs.map(safeSeg) : ['_unfiled']));
      let name = path.basename(f.path);
      let n = 1;
      while (usedBackupNames.has(path.join(dir, name).toLowerCase())) {
        name = `${f.stem} (${++n})${path.extname(f.path)}`;
      }
      usedBackupNames.add(path.join(dir, name).toLowerCase());
      return path.join(dir, name);
    };

    for (const r of rows) {
      if (control.canceled || r.skip) continue;
      if (r.match !== 'unfiled' && !r.folderId) continue;
      const label = r.eaglePath || '(unfiled)';
      for (let i = 0; i < r.newFiles.length; i += IMPORT_BATCH) {
        while (control.paused && !control.canceled) await new Promise((res) => setTimeout(res, 150));
        if (control.canceled) break;
        const batch = r.newFiles.slice(i, i + IMPORT_BATCH);

        // Re-check files still exist/unchanged; hash for the ledger.
        const ready = [];
        for (const f of batch) {
          try {
            const st = await fsp.stat(f.path);
            const full = await db.hash(f.path, st.size, st.mtimeMs, 'full');
            const quick = await db.hash(f.path, st.size, st.mtimeMs, 'quick');
            let tags = [];
            if (opts.attachTags) tags = await readSidecarTags(f, opts.threshold ?? 0.35, onLog);
            let importPath = f.path;
            if (runDir) {
              const dest = backupPathFor(r, f);
              await fsp.mkdir(path.dirname(dest), { recursive: true });
              await fsp.copyFile(f.path, dest, fs.constants.COPYFILE_EXCL);
              const copyHash = await fullHash(dest);
              if (copyHash !== full) throw new Error('backup copy does not match the original (disk problem?) — not imported');
              importPath = dest;
              stats.backedUp++;
            }
            ready.push({ f, full, quick, size: st.size, tags, importPath });
          } catch (err) {
            stats.failed++; stats.done++;
            onLog(`✗ ${f.path}: ${err.message}`, 'error');
          }
        }
        if (!ready.length) { progress(`Importing → ${label}`); continue; }

        let ids = null;
        try {
          ids = await client.addItems(ready.map((x) => ({ path: x.importPath, name: x.f.stem, tags: x.tags })), r.folderId);
        } catch (err) {
          stats.failed += ready.length; stats.done += ready.length;
          onLog(`✗ Import batch into "${label}" failed: ${err.message}`, 'error');
          progress(`Importing → ${label}`);
          continue;
        }
        if (ids && ids.length !== ready.length) {
          // Can't tell which id belongs to which file — don't guess.
          onLog(`Eagle returned ${ids.length} ids for ${ready.length} files in "${label}"; those can't be verified one by one.`, 'warning');
          ids = null;
        }

        // Record immediately (before anything else can fail or the app closes):
        // ledger (pending until verified), journal (for undo), manifest row.
        const at = new Date().toISOString();
        const idOf = (idx) => (ids ? ids[idx] ?? null : null);
        await appendNdjson(this.ledgerPath, ready.map((x, idx) => ({
          full: x.full, quick: x.quick, size: x.size, src: x.f.path,
          ...(x.importPath !== x.f.path ? { backup: x.importPath } : {}),
          eagleId: idOf(idx), folderId: r.folderId || null, folder: r.eaglePath, at,
          ...(idOf(idx) ? { pending: true } : {}),
        })));
        await journal(ready.map((x, idx) => ({
          type: 'imported', itemId: idOf(idx), folderId: r.folderId || null,
          folder: r.eaglePath, full: x.full, src: x.f.path,
        })));
        if (manifest) {
          await fsp.appendFile(manifest, ready.map((x, idx) => [x.f.path, x.importPath, r.eaglePath || '(unfiled)', idOf(idx) || '', x.full,
            idOf(idx) ? 'pending' : 'n/a (no item id)'].map(csvEsc).join(',')).join('\n') + '\n', 'utf8');
        }
        ready.forEach((x, idx) => { if (idOf(idx)) imported.push({ id: idOf(idx), full: x.full, key: idOf(idx) }); });
        stats.imported += ready.length;
        stats.done += ready.length;

        // Safety: confirm Eagle copied rather than moved.
        if (!firstBatchChecked) {
          firstBatchChecked = true;
          await new Promise((res) => setTimeout(res, 1500));
          const vanished = [];
          for (const x of ready) {
            try { await fsp.access(x.importPath); } catch { vanished.push(x.importPath); }
            if (x.importPath !== x.f.path) {
              try { await fsp.access(x.f.path); } catch { vanished.push(x.f.path); }
            }
          }
          if (vanished.length) {
            control.canceled = true;
            onLog(`✗ STOPPED: ${vanished.length} file(s) disappeared after import — Eagle may be set to move files on import. Check Eagle's import settings.${runDir ? ' Your originals were never given to Eagle (it imported from the safety copies).' : ''} First: ${vanished[0]}`, 'error');
          } else {
            onLog(`Safety check passed: ${runDir ? 'originals and safety copies are' : 'source files are'} untouched after import.`, 'success');
          }
        }

        // v2: make sure items landed in the folder; fix if Eagle ignored it.
        if (verifyFolders && ids && r.folderId) {
          try {
            const got = await client.getItems(ids);
            let fixed = 0;
            for (const it of got) {
              if (!(it.folders || []).includes(r.folderId)) {
                await client.setItemFolders(it.id, [...(it.folders || []), r.folderId]);
                fixed++;
              }
            }
            if (fixed) onLog(`Filed ${fixed} imported item(s) into "${label}" after import.`, 'warning');
          } catch (err) {
            onLog(`Couldn't verify folder placement: ${err.message}`, 'warning');
            verifyFolders = false;
          }
        }

        progress(`Importing → ${label}`);
        await db.saveIfDirty();
      }
    }
    await db.save();

    // 4. Verify: every imported item's file inside the Eagle library must be
    //    byte-identical to the original (SHA-256). Eagle accepts imports
    //    instantly and copies in the background, so this waits for Eagle to
    //    catch up (until everything checks out or nothing new lands for 5 min).
    if (imported.length) {
      const res = await verifyImports(p.imagesDir, imported, { onProgress: (n) => { stats.verified = n; progress('Waiting for Eagle / verifying'); }, onLog, control });
      stats.verified = res.verified;
      await this.markVerified(res.status);
      if (manifest) await updateManifest(manifest, res.status, onLog);
      stats.mismatched = res.bad + res.missing;
      if (stats.mismatched) {
        onLog(`⚠ Verification: ${res.verified} of ${imported.length} imports are byte-identical in Eagle; ${res.bad} differ, ${res.missing} not found yet. If Eagle is still importing, let it finish, then click "Verify last sync". Keep the backup until then.`, 'error');
      } else {
        onLog(`✓ Verified: all ${res.verified} imported file(s) are byte-identical inside Eagle's library.`, 'success');
      }
    } else if (stats.imported && client.version !== 'v2') {
      onLog('Older Eagle API returns no item IDs, so imports can\'t be verified one by one. Keep the backup until you\'ve spot-checked Eagle.', 'warning');
    }

    if (manifest) {
      const allGood = stats.imported > 0 && stats.verified === stats.imported && !stats.failed && !control.canceled;
      if (allGood) {
        onLog(`All good — the safety copy at "${runDir}" is no longer needed. Delete it whenever you're satisfied.`, 'success');
      } else if (stats.backedUp) {
        onLog(`Keep the safety copy at "${runDir}" until you've checked — see manifest.csv there for what happened to each file.`, 'warning');
      }
    }

    await journal({ type: 'end', at: new Date().toISOString(), stats: { ...stats }, canceled: Boolean(control.canceled) });
    onLog(`Run journal: ${journalPath} (use "Undo last sync" to reverse this run).`);
    this.plan = null; // force a fresh scan next time
    progress('Done');
    return stats;
  }

  // ---------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------
  async listRuns() {
    let names = [];
    try { names = (await fsp.readdir(this.runsDir)).filter((n) => n.endsWith('.ndjson')).sort(); } catch { /* none */ }
    return names.map((n) => path.join(this.runsDir, n));
  }

  // Summary of a run journal (default: the most recent not-yet-undone run).
  async describeRun(runPath) {
    if (!runPath) {
      const runs = await this.listRuns();
      for (let i = runs.length - 1; i >= 0; i--) {
        const entries = await readNdjson(runs[i]);
        if (!entries.some((e) => e.type === 'undone')) { runPath = runs[i]; break; }
      }
      if (!runPath) return null;
    }
    const entries = await readNdjson(runPath);
    const head = entries.find((e) => e.type === 'run') || {};
    return {
      runPath,
      at: head.at,
      libPath: head.libPath,
      foldersCreated: entries.filter((e) => e.type === 'folderCreated'),
      filed: entries.filter((e) => e.type === 'filed').length,
      imported: entries.filter((e) => e.type === 'imported' && e.itemId).length,
      undone: entries.some((e) => e.type === 'undone'),
    };
  }

  // Re-run verification for a past run (e.g. after Eagle finished its
  // background import) and update that run's manifest.csv.
  async verifyRun(runPath, { apiBase, token } = {}, { onProgress, onLog, control }) {
    const entries = await readNdjson(runPath);
    const client = new EagleClient({ base: apiBase || undefined, token: token || '' });
    await client.detect();
    const lib = await client.libraryInfo();
    const head = entries.find((e) => e.type === 'run') || {};
    const libPath = lib.path || head.libPath;
    if (head.libPath && lib.path && path.normalize(lib.path).toLowerCase() !== path.normalize(head.libPath).toLowerCase()) {
      throw new Error(`That run was on "${head.libPath}" but Eagle has "${lib.path}" open.`);
    }
    const imagesDir = path.join(libPath, 'images');
    const list = entries.filter((e) => e.type === 'imported' && e.itemId)
      .map((e) => ({ id: e.itemId, full: e.full, key: e.itemId }));
    if (!list.length) { onLog('That run has no verifiable imports.', 'warning'); return { verified: 0, total: 0 }; }
    onLog(`Verifying ${list.length.toLocaleString()} imported item(s) from ${path.basename(runPath)}…`);
    const total = list.length;
    const res = await verifyImports(imagesDir, list, {
      onProgress: (n) => onProgress({ phase: 'Verifying in Eagle', done: n, total, verified: n }),
      onLog, control, stallMs: 2 * 60 * 1000,
    });
    // Update the manifest (column 4 = Eagle item id, column 6 = Verified).
    const end = [...entries].reverse().find((e) => e.type === 'end');
    const backupDir = end?.stats?.backupDir;
    await this.markVerified(res.status);
    if (backupDir) await updateManifest(path.join(backupDir, 'manifest.csv'), res.status, onLog);
    await appendNdjson(runPath, [{ type: 'verified', at: new Date().toISOString(), verified: res.verified, bad: res.bad, missing: res.missing }]);
    if (res.verified === total) {
      onLog(`✓ Verified: all ${total.toLocaleString()} imported file(s) are byte-identical inside Eagle's library.${backupDir ? ` The safety copy at "${backupDir}" is safe to delete.` : ''}`, 'success');
    } else {
      onLog(`⚠ ${res.verified.toLocaleString()} of ${total.toLocaleString()} verified; ${res.bad} differ, ${res.missing} not found${res.trashed ? `, ${res.trashed} in Eagle's trash` : ''}. Keep the backup.${res.missing ? ' If Eagle is still importing, wait and verify again.' : ''}`, 'error');
    }
    onProgress({ phase: 'Done', done: res.verified, total, verified: res.verified });
    return { verified: res.verified, bad: res.bad, missing: res.missing, total, backupDir };
  }

  // Confirm imports in the ledger once they're verified in Eagle.
  async markVerified(status) {
    const ids = [...status].filter(([, v]) => v === 'yes').map(([id]) => id);
    if (ids.length) await appendNdjson(this.ledgerPath, ids.map((id) => ({ verifiedId: id })));
  }

  async lastRunPath() {
    const runs = await this.listRuns();
    for (let i = runs.length - 1; i >= 0; i--) {
      const entries = await readNdjson(runs[i]);
      if (entries.some((e) => e.type === 'undone')) continue; // undone runs aren't verifiable
      if (entries.some((e) => e.type === 'imported')) return runs[i];
    }
    return null;
  }

  // Reverses a run: removes the folder memberships it added, moves the items
  // it imported to Eagle's trash (and forgets them in the ledger so they can
  // be imported again later). Folders it created are listed for you to
  // delete in Eagle — the API has no folder delete — they'll be empty.
  async undoRun(runPath, { apiBase, token } = {}, { onProgress, onLog, control }) {
    const entries = await readNdjson(runPath);
    if (entries.some((e) => e.type === 'undone')) throw new Error('That run was already undone.');
    const head = entries.find((e) => e.type === 'run') || {};
    const client = new EagleClient({ base: apiBase || undefined, token: token || '' });
    await client.detect();
    if (client.version !== 'v2') throw new Error('Undo needs Eagle 4.0 Build 21+ (API v2).');
    const lib = await client.libraryInfo();
    if (head.libPath && lib.path && path.normalize(lib.path).toLowerCase() !== path.normalize(head.libPath).toLowerCase()) {
      throw new Error(`That run was on "${head.libPath}" but Eagle has "${lib.path}" open.`);
    }
    const folders = indexFolders(lib.folders);
    const filed = entries.filter((e) => e.type === 'filed');
    const imported = entries.filter((e) => e.type === 'imported' && e.itemId);
    const created = entries.filter((e) => e.type === 'folderCreated');
    const stats = { total: filed.length + imported.length, done: 0, unfiled: 0, trashed: 0, failed: 0 };
    const progress = () => onProgress({ phase: 'Undoing', ...stats });

    for (let i = 0; i < filed.length && !control.canceled; i += 200) {
      const chunk = filed.slice(i, i + 200);
      let current = [];
      try { current = await client.getItems(chunk.map((e) => e.itemId)); } catch (err) {
        onLog(`✗ Couldn't read items: ${err.message}`, 'error'); stats.failed += chunk.length; stats.done += chunk.length; continue;
      }
      const byId = new Map(current.map((it) => [it.id, it]));
      for (const e of chunk) {
        const it = byId.get(e.itemId);
        try {
          if (it) {
            const now = it.folders || [];
            const next = now.filter((f) => !e.added.includes(f));
            if (next.length !== now.length) { await client.setItemFolders(e.itemId, next); stats.unfiled++; }
          }
        } catch (err) { stats.failed++; onLog(`✗ ${e.itemId}: ${err.message}`, 'error'); }
        stats.done++;
      }
      progress();
    }
    const trashedIds = new Set();
    for (const e of imported) {
      if (control.canceled) break;
      try { await client.post('/api/v2/item/update', { id: e.itemId, isDeleted: true }); stats.trashed++; trashedIds.add(e.itemId); } catch (err) {
        stats.failed++; onLog(`✗ ${e.itemId}: ${err.message}`, 'error');
      }
      stats.done++;
      if (stats.done % 25 === 0) progress();
    }
    // Forget undone imports in the ledger so a later sync can import them again.
    if (stats.trashed) {
      const kept = (await readNdjson(this.ledgerPath))
        .filter((l) => !(l.eagleId && trashedIds.has(l.eagleId)) && !(l.verifiedId && trashedIds.has(l.verifiedId)));
      const tmp = `${this.ledgerPath}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, kept.map((l) => JSON.stringify(l)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
      await fsp.rename(tmp, this.ledgerPath);
    }
    if (!control.canceled) await appendNdjson(runPath, [{ type: 'undone', at: new Date().toISOString(), stats }]);
    progress();
    onLog(`Undo: removed ${stats.unfiled} folder assignment(s), moved ${stats.trashed} imported item(s) to Eagle's trash${stats.failed ? `, ${stats.failed} failed` : ''}.`, stats.failed ? 'warning' : 'success');
    const stillThere = created.filter((c) => folders.byId.has(c.id)).sort((a, b) => b.path.length - a.path.length);
    if (stillThere.length) {
      onLog(`Folders this run created (now empty) — delete them in Eagle, deepest first:`, 'warning');
      for (const c of stillThere) onLog(`   ${c.path}`, 'warning');
    }
    return { ...stats, foldersToDelete: stillThere.map((c) => c.path), canceled: Boolean(control.canceled) };
  }
}

// Hash every imported item's file in the library and compare with the
// original. list: [{ id, full, key }]. Retries until all match or no
// progress for `stallMs`. Returns counts + per-key status.
async function verifyImports(imagesDir, list, { onProgress = () => {}, onLog = () => {}, control = {}, stallMs = 5 * 60 * 1000 } = {}) {
  const status = new Map(); // key (Eagle item id) -> 'yes' | 'MISMATCH' | 'NOT FOUND' | 'IN TRASH'
  let pending = list.slice();
  let verified = 0;
  let trashed = 0;
  let lastProgress = Date.now();
  let round = 0;
  while (pending.length && !control.canceled) {
    if (round++) {
      if (Date.now() - lastProgress > stallMs) break;
      onLog(`Waiting for Eagle to finish writing… ${verified.toLocaleString()} / ${list.length.toLocaleString()} verified so far.`);
      await new Promise((res) => setTimeout(res, 15000));
    }
    const next = [];
    await runPool(pending, 8, async (x) => {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(imagesDir, `${x.id}.info`, 'metadata.json'), 'utf8'));
        if (meta.isDeleted) { status.set(x.key, 'IN TRASH'); trashed++; return; } // not counted as verified
        const { p: file, st } = await resolveEagleFile(imagesDir, { id: x.id, name: meta.name, ext: meta.ext });
        const h = await fullHash(file, st.size);
        if (h === x.full) {
          verified++;
          status.set(x.key, 'yes');
          lastProgress = Date.now();
          if (verified % 200 === 0) onProgress(verified);
        } else {
          next.push(x); // may still be mid-write — retry
          status.set(x.key, 'MISMATCH');
        }
      } catch {
        next.push(x);
        if (!status.has(x.key)) status.set(x.key, 'NOT FOUND');
      }
    }, control);
    pending = next;
    onProgress(verified);
  }
  const bad = pending.filter((x) => status.get(x.key) === 'MISMATCH').length;
  return { verified, bad, missing: pending.length - bad, trashed, status };
}

// Rewrite manifest.csv's "Verified in Eagle" column (index 5) by item id (index 3).
async function updateManifest(mpath, status, onLog = () => {}) {
  try {
    const lines = (await fsp.readFile(mpath, 'utf8')).split('\n');
    const out = lines.map((line, i) => {
      if (i === 0 || !line.trim()) return line;
      const cols = parseCsvLine(line);
      const v = status.get(cols[3]);
      if (v) cols[5] = v;
      return cols.map(csvEsc).join(',');
    });
    const tmp = `${mpath}.tmp`;
    await fsp.writeFile(tmp, out.join('\n'), 'utf8');
    await fsp.rename(tmp, mpath);
  } catch (err) { onLog(`Couldn't update manifest.csv: ${err.message}`, 'warning'); }
}

// Tags from the Booru Tagger sidecar: <dir>/Json/<stem>.json. A sidecar that
// exists but can't be parsed (e.g. the Tagger is writing it right now) is
// reported instead of silently importing the image without tags.
async function readSidecarTags(f, threshold, onLog = () => {}) {
  for (const dirName of ['Json', 'json', 'JSON']) {
    const p = path.join(f.dir, dirName, `${f.stem}.json`);
    let raw;
    try { raw = await fsp.readFile(p, 'utf8'); } catch { continue; }
    try {
      return extractTags(JSON.parse(raw), threshold) || [];
    } catch {
      onLog(`Tag file unreadable, imported without tags: ${p}`, 'warning');
      return [];
    }
  }
  return [];
}

module.exports = { EagleSync, buildExtSet, TYPE_EXTS };
