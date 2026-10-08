// Minimal client for Eagle's local web API.
//
// Prefers the V2 API (Eagle 4.0 Build 21+): it returns item IDs on import,
// reports the open library's path, and can update an item's folders.
// Falls back to the V1 API (/api/...) on older Eagle builds, with reduced
// features (no IDs returned, no folder filing of existing items, library path
// must be set manually).
//
// Uses 127.0.0.1, not "localhost": Node 17+ may resolve localhost to ::1,
// and Eagle listens on IPv4.

const http = require('http');

const DEFAULT_BASE = 'http://127.0.0.1:41595';

class EagleApiError extends Error {}

class EagleClient {
  constructor({ base = DEFAULT_BASE, token = '', timeoutMs = 120000 } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.version = null; // 'v2' | 'v1'
    this.appInfo = null;
  }

  url(p, query = {}) {
    const u = new URL(this.base + p);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    if (this.token) u.searchParams.set('token', this.token);
    return u.toString();
  }

  // Plain node:http with no keep-alive: Eagle is local, so a fresh
  // connection per call costs nothing and survives Eagle restarts cleanly.
  request(method, p, { query, body, timeoutMs } = {}) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request(this.url(p, query), {
        method,
        agent: false,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => reject(new EagleApiError(`Eagle API ${p}: ${err.message}`)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch {
            const e = new EagleApiError(`Eagle API ${p}: HTTP ${res.statusCode}, non-JSON response`);
            e.httpStatus = res.statusCode;
            return reject(e);
          }
          if (res.statusCode >= 400 || json.status !== 'success') {
            const e = new EagleApiError(`Eagle API ${p}: ${json.message || (typeof json.data === 'string' ? json.data : '') || `HTTP ${res.statusCode}`}`);
            e.httpStatus = res.statusCode;
            return reject(e);
          }
          resolve(json.data);
        });
      });
      req.setTimeout(timeoutMs ?? this.timeoutMs, () => {
        req.destroy(new EagleApiError(`Eagle API timed out (${p})`));
      });
      req.on('error', (err) => {
        if (err instanceof EagleApiError) return reject(err);
        reject(new EagleApiError(`Can't reach Eagle at ${this.base} — is Eagle running? (${err.code || err.message})`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(p, query, opts = {}) { return this.request('GET', p, { ...opts, query }); }
  post(p, body, opts = {}) { return this.request('POST', p, { ...opts, body }); }

  // Figure out which API generation the running Eagle speaks.
  async detect() {
    try {
      this.appInfo = await this.get('/api/v2/app/info', undefined, { timeoutMs: 5000 });
      this.version = 'v2';
      return this.version;
    } catch (err) {
      // No HTTP status = network failure/timeout: Eagle isn't running.
      // An HTTP error means Eagle answered but has no V2 API — try V1.
      if (err.httpStatus === undefined) throw err;
    }
    this.appInfo = await this.get('/api/application/info', undefined, { timeoutMs: 5000 });
    this.version = 'v1';
    return this.version;
  }

  get canFileExisting() { return this.version === 'v2'; }

  // { path: string|null, name: string|null, folders: tree }
  async libraryInfo() {
    if (this.version === 'v2') {
      const d = await this.get('/api/v2/library/info');
      // library/info may be a snapshot from when the library was opened, so
      // also merge the live folder list — otherwise a folder created since
      // could look missing and get created twice.
      let live = [];
      try { live = await this.get('/api/folder/list'); } catch { /* V1 route absent — fine */ }
      // Live list first: for any folder in both, its current name and
      // position win over the (possibly stale) snapshot.
      return { path: d.path || null, name: d.name || null, folders: mergeFolderTrees(Array.isArray(live) ? live : [], d.folders || []) };
    }
    const d = await this.get('/api/library/info');
    let folders = d.folders;
    if (!Array.isArray(folders)) folders = await this.get('/api/folder/list');
    return { path: null, name: null, folders: folders || [] };
  }

  // Calls onPage(items[]) for every page of items. Fields used downstream:
  // id, name, ext, size, folders, isDeleted.
  async listItems(onPage, shouldStop = () => false) {
    const limit = 1000;
    let total = null;
    let page = [];
    for (let offset = 0; ; offset += page.length) {
      if (shouldStop()) return;
      if (this.version === 'v2') {
        // POST with a real array: Eagle's GET handler doesn't split a
        // comma-separated `fields` string ("fields.forEach is not a function").
        let d;
        if (this.fieldsOk !== false) {
          try {
            d = await this.post('/api/v2/item/get', {
              offset, limit, fields: ['id', 'name', 'ext', 'size', 'folders', 'isDeleted'],
            });
            this.fieldsOk = true;
          } catch (err) {
            if (this.fieldsOk === true) throw err;
            this.fieldsOk = false; // field selection not supported — fetch full items
          }
        }
        if (this.fieldsOk === false) d = await this.post('/api/v2/item/get', { offset, limit });
        page = Array.isArray(d) ? d : (d.data || []);
        if (!Array.isArray(d) && typeof d.total === 'number') total = d.total;
      } else {
        page = await this.get('/api/item/list', { offset, limit });
        if (!Array.isArray(page)) page = [];
      }
      if (page.length) await onPage(page);
      if (!page.length) return;
      // Eagle may cap the page size below `limit`; trust `total` when given.
      if (total !== null ? offset + page.length >= total : page.length < limit) return;
    }
  }

  // Returns the new folder's id.
  async createFolder(name, parentId) {
    if (this.version === 'v2') {
      const d = await this.post('/api/v2/folder/create', parentId ? { name, parent: parentId } : { name });
      return d.id;
    }
    const d = await this.post('/api/folder/create', parentId ? { folderName: name, parent: parentId } : { folderName: name });
    return d.id;
  }

  // items: [{ path, name, tags? }]. Returns array of ids (v2) or null (v1).
  async addItems(items, folderId) {
    if (this.version === 'v2') {
      const payload = items.map((it) => ({
        path: it.path,
        name: it.name,
        ...(it.tags && it.tags.length ? { tags: it.tags } : {}),
        ...(folderId ? { folders: [folderId] } : {}),
      }));
      const d = await this.post('/api/v2/item/add', { items: payload }, { timeoutMs: 15 * 60 * 1000 });
      if (Array.isArray(d?.ids)) return d.ids;
      if (d?.id) return [d.id];
      return null;
    }
    await this.post('/api/item/addFromPaths', {
      items: items.map((it) => ({ path: it.path, name: it.name, tags: it.tags || [] })),
      ...(folderId ? { folderId } : {}),
    }, { timeoutMs: 15 * 60 * 1000 });
    return null;
  }

  // v2 only: fetch specific items (to verify folder assignment).
  async getItems(ids) {
    let d;
    try {
      d = await this.post('/api/v2/item/get', { ids, fields: ['id', 'folders'], limit: ids.length });
    } catch {
      d = await this.post('/api/v2/item/get', { ids, limit: ids.length });
    }
    return Array.isArray(d) ? d : (d.data || []);
  }

  // v2 only: replace an item's folder list.
  async setItemFolders(id, folders) {
    return this.post('/api/v2/item/update', { id, folders });
  }
}

// Union of two folder trees by id (children merged recursively).
function mergeFolderTrees(a, b) {
  const byId = new Map();
  const out = [];
  const add = (list, target) => {
    for (const f of list || []) {
      if (!f || !f.id) continue;
      let node = byId.get(f.id);
      if (!node) {
        node = { id: f.id, name: f.name, children: [] };
        byId.set(f.id, node);
        target.push(node);
      }
      add(f.children, node.children);
    }
  };
  add(a, out);
  add(b, out);
  return out;
}

// Flatten Eagle's folder tree into path-keyed lookups.
// Paths are "Parent/Child" using the folder names; keys are case-insensitive.
// Keys are built from the list of names, not a "/"-joined string, so an
// Eagle folder literally named "Fate/Zero" can't collide with Fate > Zero.
// `path` stays "/"-joined for display only.
function segKey(segs) {
  return segs.map(normKey).join('\u0001');
}

function indexFolders(tree) {
  const byPath = new Map();   // segKey -> { id, path, segs, name }
  const byName = new Map();   // lowerName -> [entry]
  const byId = new Map();     // id -> entry
  const walk = (nodes, parentSegs) => {
    for (const f of nodes || []) {
      if (!f || !f.id || byId.has(f.id)) continue;
      const name = String(f.name ?? '');
      const segs = [...parentSegs, name];
      const entry = { id: f.id, path: segs.join('/'), segs, name };
      byPath.set(segKey(segs), entry);
      const nk = normKey(name);
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(entry);
      byId.set(f.id, entry);
      walk(f.children, segs);
    }
  };
  walk(tree, []);
  return { byPath, byName, byId };
}

function normKey(s) {
  return String(s).trim().normalize('NFC').toLowerCase();
}

module.exports = { EagleClient, EagleApiError, indexFolders, mergeFolderTrees, normKey, segKey, DEFAULT_BASE };
