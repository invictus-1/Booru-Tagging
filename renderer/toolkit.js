// Booru Suite — Renamer, Tag Merger and Eagle Sync tabs (from Eagle Toolkit).
(() => {
  'use strict';

  // Eagle Toolkit — renderer logic (vanilla).

  const ROOT = document.getElementById('view-toolkit');
  // Lookups stay inside this tool's view (both tools reuse ids like logView);
  // fall back to the document for shared chrome such as the header.
  const $ = (id) => ROOT.querySelector('#' + CSS.escape(id)) || document.getElementById(id);

  const state = {
    activeTab: 'rename',
    running: false,
    // folder lists keyed by container id
    lists: { renameFolders: [], tagFolders: [], metaFolders: [], syncSources: [] },
    renameSubfolders: true,
    mergeMode: 'all',
    mergeThreshold: 0.35,
    sync: {
      mapping: 'self',
      matchMode: 'full',
      types: { images: true, gifs: true, videos: true },
      extraExts: '',
      fileExisting: true,
      restoreDeleted: false,
      attachTags: true,
      threshold: 0.35,
      apiBase: '',
      token: '',
      libraryPath: '',
      safetyCopy: true,
      backupDir: '',
    },
    plan: null,            // last scan summary
    planSelected: new Set(),
  };

  const SYNC_MAPPING_HINTS = {
    self: 'Each folder you add becomes an Eagle folder of the same name; its subfolders nest inside it. E.g. D:\\Booru\\Artists → Eagle "Booru / Artists".',
    children: 'The folders you add are just containers: the folders inside them map to top-level Eagle folders. E.g. D:\\Booru\\Artists → Eagle "Artists". Loose files directly in the container go unfiled (off by default).',
  };
  const SYNC_MATCH_HINTS = {
    full: 'SHA-256 of every byte — byte-identical guarantee. Only files whose size matches something on the other side get hashed, and every hash is cached, so only the first run is slow.',
    quick: 'Hashes size + first and last 256 KB. Far faster on HDDs and big videos; files under 512 KB are still checked in full. Practically never wrong for media, but not a strict guarantee.',
  };

  const MERGE_MODE_HINTS = {
    all: 'Process every Eagle item, even ones merged before.',
    new: 'Skip items already merged successfully — also resumes a canceled run.',
  };

  // ---------------------------------------------------------------------------
  // Settings persistence
  // ---------------------------------------------------------------------------
  function saveSettings() {
    localStorage.setItem('et-settings', JSON.stringify({
      lists: state.lists,
      renameSubfolders: state.renameSubfolders,
      mergeMode: state.mergeMode,
      mergeThreshold: state.mergeThreshold,
      sync: state.sync,
    }));
  }

  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('et-settings')); } catch { /* fresh */ }
    if (!saved) return;
    state.lists = { renameFolders: [], tagFolders: [], metaFolders: [], syncSources: [], ...saved.lists };
    state.sync = { ...state.sync, ...(saved.sync || {}), types: { ...state.sync.types, ...((saved.sync || {}).types || {}) } };
    state.renameSubfolders = saved.renameSubfolders ?? true;
    state.mergeMode = saved.mergeMode ?? 'all';
    state.mergeThreshold = saved.mergeThreshold ?? 0.35;

    $('renameSubfolders').checked = state.renameSubfolders;
    $('mergeThreshold').value = state.mergeThreshold;
    $('mergeThresholdVal').textContent = Number(state.mergeThreshold).toFixed(2);
    syncMergeModeUI();
    for (const key of Object.keys(state.lists)) renderList(key);
  }

  function applySyncSettingsToUI() {
    const y = state.sync;
    $('syncTypeImages').checked = y.types.images;
    $('syncTypeGifs').checked = y.types.gifs;
    $('syncTypeVideos').checked = y.types.videos;
    $('syncExtraExts').value = y.extraExts;
    $('syncFileExisting').checked = y.fileExisting;
    $('syncRestoreDeleted').checked = y.restoreDeleted;
    $('syncAttachTags').checked = y.attachTags;
    $('syncThreshold').value = y.threshold;
    $('syncThresholdVal').textContent = Number(y.threshold).toFixed(2);
    $('syncThresholdField').classList.toggle('dim', !y.attachTags);
    $('syncApiBase').value = y.apiBase;
    $('syncToken').value = y.token;
    $('syncLibraryPath').value = y.libraryPath;
    $('syncSafetyCopy').checked = y.safetyCopy;
    $('syncBackupDir').value = y.backupDir;
    $('syncBackupField').classList.toggle('dim', !y.safetyCopy);
    syncSegUI();
  }

  function syncSegUI() {
    ROOT.querySelectorAll('#syncMappingSeg .seg-opt').forEach((b) =>
      b.classList.toggle('active', b.dataset.mapping === state.sync.mapping));
    ROOT.querySelectorAll('#syncMatchSeg .seg-opt').forEach((b) =>
      b.classList.toggle('active', b.dataset.match === state.sync.matchMode));
    $('syncMappingHint').textContent = SYNC_MAPPING_HINTS[state.sync.mapping];
    $('syncMatchHint').textContent = SYNC_MATCH_HINTS[state.sync.matchMode];
  }

  // ---------------------------------------------------------------------------
  // Folder lists (generic: three lists share one renderer)
  // ---------------------------------------------------------------------------
  const EMPTY_IDS = {
    renameFolders: 'renameFoldersEmpty',
    tagFolders: 'tagFoldersEmpty',
    metaFolders: 'metaFoldersEmpty',
    syncSources: 'syncSourcesEmpty',
  };

  function renderList(key) {
    const container = $(key);
    container.innerHTML = '';
    $(EMPTY_IDS[key]).style.display = state.lists[key].length ? 'none' : 'block';

    for (const folderPath of state.lists[key]) {
      const item = document.createElement('div');
      item.className = 'folder-item';

      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = folderPath;
      name.title = folderPath;

      const rm = document.createElement('button');
      rm.className = 'folder-remove';
      rm.textContent = '×';
      rm.disabled = state.running;
      rm.onclick = () => {
        state.lists[key] = state.lists[key].filter((p) => p !== folderPath);
        if (key === 'syncSources') invalidatePlan();
        renderList(key); saveSettings(); updateStartButtons();
      };

      item.append(name, rm);
      container.appendChild(item);
    }
    updateStartButtons();
  }

  ROOT.querySelectorAll('[data-add]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.add;
      const paths = await window.tk.selectFolders();
      for (const p of paths) {
        if (!state.lists[key].includes(p)) state.lists[key].push(p);
      }
      if (key === 'syncSources' && paths.length) invalidatePlan();
      renderList(key); saveSettings();
    };
  });

  function updateStartButtons() {
    $('renameStartBtn').disabled = state.running || state.lists.renameFolders.length === 0;
    $('mergeStartBtn').disabled = state.running ||
      state.lists.tagFolders.length === 0 || state.lists.metaFolders.length === 0;
    $('syncScanBtn').disabled = state.running || state.lists.syncSources.length === 0;
    const work = selectedWork();
    $('syncImportBtn').disabled = state.running || !state.plan || work.count === 0;
    $('syncImportBtn').textContent = state.plan && work.count
      ? `Import ${work.newFiles.toLocaleString()}${work.filing ? ` + file ${work.filing.toLocaleString()}` : ''}`
      : 'Import';
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  // Tool switching is driven by the suite header (see shell.js).
  const TOOL_OF_JOB = { rename: 'rename', merge: 'merge', syncScan: 'sync', sync: 'sync', verify: 'sync', undo: 'sync' };
  const lastStatsByTab = {}; // tab -> { job, stats } so each tool shows its own last numbers
  function selectTool(tool) {
    if (state.running && tool !== state.activeTab) return false; // finish the running job first
    state.activeTab = tool;
    if (!state.running) {
      const last = lastStatsByTab[tool];
      currentTool = last ? last.job : (tool === 'sync' ? 'syncScan' : tool);
      renderStats(currentTool, last ? last.stats : {});
      $('phaseLabel').textContent = 'Idle';
    }
    for (const t of ['rename', 'merge', 'sync']) $(`panel-${t}`).classList.toggle('hidden', state.activeTab !== t);
    $('planCard').classList.toggle('hidden', state.activeTab !== 'sync' || !state.plan);
    if (state.activeTab === 'sync' && !syncStatusChecked) refreshEagleStatus();
    return true;
  }
  window.__toolkit = {
    select: (tool) => selectTool(tool),
    isRunning: () => state.running,
    runningTool: () => (state.running ? TOOL_OF_JOB[currentTool] || state.activeTab : null),
    activeTool: () => state.activeTab,
  };

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  $('renameSubfolders').onchange = (e) => { state.renameSubfolders = e.target.checked; saveSettings(); };

  function syncMergeModeUI() {
    ROOT.querySelectorAll('#mergeModeSeg .seg-opt').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === state.mergeMode));
    $('mergeModeHint').textContent = MERGE_MODE_HINTS[state.mergeMode];
  }
  ROOT.querySelectorAll('#mergeModeSeg .seg-opt').forEach((b) => {
    b.onclick = () => { state.mergeMode = b.dataset.mode; syncMergeModeUI(); saveSettings(); };
  });

  $('mergeThreshold').oninput = (e) => {
    state.mergeThreshold = Number(e.target.value);
    $('mergeThresholdVal').textContent = state.mergeThreshold.toFixed(2);
    saveSettings();
  };

  $('pauseBtn').onclick = () => window.tk.togglePause();
  $('cancelBtn').onclick = () => window.tk.cancelJob();

  function setRunning(running) {
    state.running = running;
    updateStartButtons();
    $('pauseBtn').disabled = !running;
    $('cancelBtn').disabled = !running;
    ROOT.querySelectorAll('.tab, [data-add], #mergeModeSeg .seg-opt, #syncMappingSeg .seg-opt, #syncMatchSeg .seg-opt, #panel-sync input, #syncRefreshBtn, #syncLibraryPick, #syncBackupPick, #syncUndoBtn, #syncVerifyBtn, #planCard input, #planCard .link-btn')
      .forEach((b) => { b.disabled = running; });
    $('renameSubfolders').disabled = running;
    $('mergeThreshold').disabled = running;
    for (const key of Object.keys(state.lists)) renderList(key);
    if (state.plan) renderPlan();
  }

  // ---------------------------------------------------------------------------
  // Log & progress
  // ---------------------------------------------------------------------------
  const MAX_LOG_LINES = 800;
  function addLog(message, type = 'info') {
    const view = $('logView');
    const line = document.createElement('div');
    line.className = type;
    line.textContent = message;
    view.appendChild(line);
    while (view.childNodes.length > MAX_LOG_LINES) view.removeChild(view.firstChild);
    if ($('autoScroll').checked) view.scrollTop = view.scrollHeight;
  }

  // Stats rows differ per tool; render generically from a spec.
  const STAT_SPECS = {
    rename: [
      ['renamed', 'renamed', 'ok'],
      ['skipped', 'skipped', 'warn'],
      ['failed', 'failed', 'bad'],
    ],
    merge: [
      ['updated', 'updated', 'ok'],
      ['tagsAdded', 'tags added', 'ok'],
      ['unchanged', 'unchanged', ''],
      ['noMatch', 'no match', 'warn'],
      ['failed', 'failed', 'bad'],
    ],
    syncScan: [
      ['hashedNew', 'newly hashed', ''],
    ],
    verify: [
      ['verified', 'verified', 'ok'],
    ],
    undo: [
      ['unfiled', 'folder assignments removed', 'ok'],
      ['trashed', 'moved to trash', 'warn'],
      ['failed', 'failed', 'bad'],
    ],
    sync: [
      ['imported', 'imported', 'ok'],
      ['verified', 'verified', 'ok'],
      ['filed', 'filed into folder', 'ok'],
      ['foldersCreated', 'folders created', ''],
      ['failed', 'failed', 'bad'],
    ],
  };

  function renderStats(tool, stats) {
    $('doneCount').textContent = stats.done ?? 0;
    $('totalCount').textContent = stats.total ?? 0;
    const pct = stats.total > 0 ? ((stats.done ?? 0) / stats.total) * 100 : 0;
    $('barFill').style.width = `${pct}%`;

    const row = $('statsRow');
    row.innerHTML = '';
    for (const [key, label, cls] of STAT_SPECS[tool]) {
      const stat = document.createElement('div');
      stat.className = 'stat';
      const num = document.createElement('span');
      num.className = `stat-num ${cls}`.trim();
      num.textContent = stats[key] ?? 0;
      const lab = document.createElement('span');
      lab.className = 'stat-label';
      lab.textContent = label;
      stat.append(num, lab);
      row.appendChild(stat);
    }
  }

  let currentTool = 'rename';

  window.tk.on('log', ({ message, type }) => addLog(message, type));
  window.tk.on('progress', (stats) => {
    if (stats.phase && !state.paused) $('phaseLabel').textContent = stats.phase;
    renderStats(currentTool, stats);
    lastStatsByTab[TOOL_OF_JOB[currentTool] || state.activeTab] = { job: currentTool, stats };
  });
  window.tk.on('pause-state', (paused) => {
    state.paused = paused;
    $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
    $('phaseLabel').textContent = paused ? 'Paused' : 'Working...';
  });
  window.tk.on('job-phase', ({ phase }) => {
    if (phase === 'idle') $('phaseLabel').textContent = 'Idle';
  });

  // ---------------------------------------------------------------------------
  // Start buttons
  // ---------------------------------------------------------------------------
  async function runJob(tool, invoke) {
    if (state.running) return;
    currentTool = tool;
    setRunning(true);
    $('phaseLabel').textContent = 'Working...';
    renderStats(tool, {});
    try {
      const result = await invoke();
      if (result && result.canceled && !result.aborted) addLog('Job canceled.', 'warning');
      return result;
    } catch (err) {
      addLog(`Job error: ${err.message}`, 'error');
    } finally {
      state.paused = false;
      setRunning(false);
      $('pauseBtn').textContent = 'Pause';
      $('phaseLabel').textContent = 'Idle';
    }
  }

  $('renameStartBtn').onclick = () => runJob('rename', () => window.tk.runRename({
    folders: state.lists.renameFolders,
    includeSubfolders: state.renameSubfolders,
  }));

  $('mergeStartBtn').onclick = () => runJob('merge', () => window.tk.runMerge({
    tagFolders: state.lists.tagFolders,
    metadataFolders: state.lists.metaFolders,
    mode: state.mergeMode,
    threshold: state.mergeThreshold,
  }));

  // ---------------------------------------------------------------------------
  // Eagle Sync
  // ---------------------------------------------------------------------------
  let syncStatusChecked = false;

  function syncConn() {
    return { apiBase: state.sync.apiBase.trim(), token: state.sync.token.trim() };
  }

  async function refreshEagleStatus() {
    syncStatusChecked = true;
    $('eagleDot').className = 'dot';
    $('eagleStatusText').textContent = 'Checking…';
    const s = await window.tk.syncStatus(syncConn());
    if (s.ok) {
      $('eagleDot').className = `dot ${s.api === 'v2' ? 'ok' : 'warn'}`;
      const ver = [s.eagleVersion, s.build].filter(Boolean).join(' ');
      $('eagleStatusText').textContent = s.api === 'v2'
        ? `Eagle ${ver} · library: ${s.libraryName || s.libraryPath}`
        : `Eagle ${ver} (older API) — set the library path under Advanced; filing existing items is unavailable.`;
      $('eagleStatusText').title = s.libraryPath || '';
    } else {
      $('eagleDot').className = 'dot bad';
      $('eagleStatusText').textContent = 'Eagle isn\'t reachable — open Eagle, then Check again.';
      $('eagleStatusText').title = s.error || '';
    }
  }
  $('syncRefreshBtn').onclick = refreshEagleStatus;

  function invalidatePlan() {
    if (!state.plan) return;
    state.plan = null;
    state.planSelected.clear();
    $('planCard').classList.add('hidden');
    updateStartButtons();
  }

  // Settings that change the plan's meaning invalidate it.
  const bindSync = (id, key, { event = 'onchange', parse = (e) => e.target.checked, invalidates = true } = {}) => {
    $(id)[event] = (e) => {
      state.sync[key] = parse(e);
      if (invalidates) invalidatePlan();
      if (key === 'attachTags') $('syncThresholdField').classList.toggle('dim', !state.sync.attachTags);
      if (key === 'safetyCopy') $('syncBackupField').classList.toggle('dim', !state.sync.safetyCopy);
      saveSettings();
    };
  };
  const bindType = (id, key) => {
    $(id).onchange = (e) => { state.sync.types[key] = e.target.checked; invalidatePlan(); saveSettings(); };
  };
  bindType('syncTypeImages', 'images');
  bindType('syncTypeGifs', 'gifs');
  bindType('syncTypeVideos', 'videos');
  bindSync('syncExtraExts', 'extraExts', { parse: (e) => e.target.value });
  bindSync('syncFileExisting', 'fileExisting');
  bindSync('syncRestoreDeleted', 'restoreDeleted');
  bindSync('syncAttachTags', 'attachTags', { invalidates: false });
  bindSync('syncApiBase', 'apiBase', { parse: (e) => e.target.value });
  bindSync('syncToken', 'token', { parse: (e) => e.target.value });
  bindSync('syncLibraryPath', 'libraryPath', { parse: (e) => e.target.value });
  bindSync('syncSafetyCopy', 'safetyCopy', { invalidates: false });
  bindSync('syncBackupDir', 'backupDir', { parse: (e) => e.target.value });
  $('syncBackupPick').onclick = async () => {
    const p = await window.tk.selectFolder();
    if (!p) return;
    state.sync.backupDir = p;
    $('syncBackupDir').value = p;
    invalidatePlan(); saveSettings();
  };
  $('syncThreshold').oninput = (e) => {
    state.sync.threshold = Number(e.target.value);
    $('syncThresholdVal').textContent = state.sync.threshold.toFixed(2);
    saveSettings();
  };
  $('syncLibraryPick').onclick = async () => {
    const p = await window.tk.selectFolder();
    if (!p) return;
    state.sync.libraryPath = p;
    $('syncLibraryPath').value = p;
    invalidatePlan(); saveSettings();
  };
  ROOT.querySelectorAll('#syncMappingSeg .seg-opt').forEach((b) => {
    b.onclick = () => { state.sync.mapping = b.dataset.mapping; syncSegUI(); invalidatePlan(); saveSettings(); };
  });
  ROOT.querySelectorAll('#syncMatchSeg .seg-opt').forEach((b) => {
    b.onclick = () => { state.sync.matchMode = b.dataset.match; syncSegUI(); invalidatePlan(); saveSettings(); };
  });

  const MATCH_BADGES = {
    path: ['matched', 'ok'],
    name: ['matched by name', 'warn'],
    missing: ['missing · will ask', 'new'],
    unfiled: ['unfiled', 'dim'],
  };

  function selectedWork() {
    const out = { count: 0, newFiles: 0, filing: 0 };
    if (!state.plan) return out;
    for (const r of state.plan.rows) {
      if (!state.planSelected.has(r.key)) continue;
      const filing = state.plan.canFileExisting && state.sync.fileExisting && r.match !== 'unfiled' ? r.elsewhere : 0;
      out.newFiles += r.newFiles;
      out.filing += filing;
      out.count += r.newFiles + filing;
    }
    return out;
  }

  function renderPlan() {
    const plan = state.plan;
    $('planCard').classList.toggle('hidden', !plan || state.activeTab !== 'sync');
    if (!plan) return;
    const t = plan.totals;
    const chips = [
      [t.newFiles, 'new', 'ok'],
      [t.inPlace, 'already in place', ''],
      [t.elsewhere, 'in another Eagle folder', 'warn'],
      [t.missingFolders, 'folders missing in Eagle', t.missingFolders ? 'new' : ''],
      [t.dupOnPc, 'duplicates on PC', ''],
      [t.inTrash, 'in Eagle trash', ''],
      [t.deleted, 'deleted from Eagle', ''],
      [t.unverified || 0, "couldn't verify — left out", 'warn'],
    ].filter(([n], i) => n > 0 || i < 2);
    const sum = $('planSummary');
    sum.innerHTML = '';
    for (const [n, label, cls] of chips) {
      const c = document.createElement('span');
      c.className = `chip ${cls}`.trim();
      const b = document.createElement('b');
      b.textContent = Number(n).toLocaleString();
      c.append(b, ` ${label}`);
      sum.appendChild(c);
    }

    const body = $('planBody');
    body.innerHTML = '';
    for (const r of plan.rows) {
      const tr = document.createElement('tr');
      if (!r.hasWork) tr.className = 'idle';

      const tdC = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.planSelected.has(r.key);
      cb.disabled = state.running || !r.hasWork;
      cb.onchange = () => {
        if (cb.checked) state.planSelected.add(r.key); else state.planSelected.delete(r.key);
        updateStartButtons();
      };
      tdC.appendChild(cb);

      const tdName = document.createElement('td');
      const name = document.createElement('div');
      name.className = 'plan-name';
      name.textContent = r.eaglePath;
      name.title = r.eaglePath;
      const [badgeText, badgeCls] = MATCH_BADGES[r.match] || [r.match, ''];
      const badge = document.createElement('span');
      badge.className = `badge ${badgeCls}`;
      badge.textContent = badgeText;
      if (r.match === 'name') badge.title = `No folder at this exact path; matched the only Eagle folder with this name: ${r.matchedPath}`;
      if (r.match === 'missing') badge.title = `Will be created in Eagle as: ${r.createPath}`;
      const cell = document.createElement('div');
      cell.className = 'plan-cell';
      cell.append(name, badge);
      tdName.appendChild(cell);

      const num = (v, cls = '') => {
        const td = document.createElement('td');
        td.className = `num ${v ? cls : 'zero'}`.trim();
        td.textContent = Number(v).toLocaleString();
        return td;
      };
      const skipped = r.dupOnPc + r.inTrash + r.deleted + (r.unverified || 0);
      const tdSkip = num(skipped, r.unverified ? 'warn' : '');
      tdSkip.title = `${r.dupOnPc} duplicate(s) on PC · ${r.inTrash} in Eagle trash · ${r.deleted} deleted from Eagle`
        + (r.unverified ? ` · ${r.unverified} couldn't be read to rule out a duplicate (not imported — scan again later)` : '');

      tr.append(tdC, tdName, num(r.newFiles, 'ok'), num(r.inPlace), num(r.elsewhere, 'warn'), tdSkip);
      body.appendChild(tr);
    }
    updateStartButtons();
  }

  $('planSelectAll').onclick = () => {
    if (!state.plan) return;
    state.plan.rows.filter((r) => r.hasWork).forEach((r) => state.planSelected.add(r.key));
    renderPlan();
  };
  $('planSelectNone').onclick = () => { state.planSelected.clear(); renderPlan(); };

  $('syncScanBtn').onclick = async () => {
    invalidatePlan();
    const result = await runJob('syncScan', () => window.tk.runSyncScan({
      sources: state.lists.syncSources,
      mapping: state.sync.mapping,
      matchMode: state.sync.matchMode,
      types: state.sync.types,
      extraExts: state.sync.extraExts,
      fileExisting: state.sync.fileExisting,
      restoreDeleted: state.sync.restoreDeleted,
      attachTags: state.sync.attachTags,
      threshold: state.sync.threshold,
      libraryPath: state.sync.libraryPath.trim() || undefined,
      safetyCopy: state.sync.safetyCopy,
      backupDir: state.sync.backupDir.trim() || undefined,
      ...syncConn(),
    }));
    if (result && result.rows) {
      state.plan = result;
      state.planSelected = new Set(result.rows.filter((r) => r.hasWork && r.match !== 'unfiled').map((r) => r.key));
      renderPlan();
      if (!selectedWork().count) addLog('Everything is already in Eagle — nothing to import.', 'success');
    }
  };

  $('syncImportBtn').onclick = async () => {
    if (!state.plan) return;
    const result = await runJob('sync', () => window.tk.runSyncExecute({
      selected: [...state.planSelected],
      overrides: {
        attachTags: state.sync.attachTags,
        threshold: state.sync.threshold,
        safetyCopy: state.sync.safetyCopy,
        backupDir: state.sync.backupDir.trim() || '',
      },
    }));
    if (result && result.aborted) { addLog('Import not started.', 'warning'); return; }
    if (result && typeof result.imported === 'number') renderStats('sync', { ...result, done: result.done ?? 0, total: result.total ?? 0 });
    invalidatePlan(); // a fresh scan is needed after importing
    if (result && !result.canceled) addLog('Scan again any time to confirm everything is in place.');
  };

  $('syncVerifyBtn').onclick = () => runJob('verify', () => window.tk.runSyncVerify(syncConn()));

  $('syncUndoBtn').onclick = async () => {
    const result = await runJob('undo', () => window.tk.runSyncUndo(syncConn()));
    if (result && !result.aborted) invalidatePlan();
  };

  // ---------------------------------------------------------------------------
  loadSettings();
  applySyncSettingsToUI();
  addLog('Booru Suite — Renamer / Tag Merger / Eagle Sync ready.');
})();
