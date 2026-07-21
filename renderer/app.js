// Booru Tagger V3 — renderer logic (vanilla, no frameworks).
'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State (persisted to localStorage)
// ---------------------------------------------------------------------------
const state = {
  folders: [],           // [{path, imageCount, jsonCount}]
  model: 'both',
  threshold: 0.1,
  parallel: 4,
  mode: 'all',
  includeSubfolders: true,
  hfToken: '',
  running: false,
  paused: false,
};

const MODE_HINTS = {
  all: 'Tag every image, re-tagging ones done before.',
  new: 'Skip images already logged as successfully tagged.',
  missing: 'Only tag images that have no JSON file yet.',
  update: 'Re-tag only already-tagged images — replaces their tags with the selected model\'s output. Use after switching or adding models.',
};

function saveSettings() {
  localStorage.setItem('bt3-settings', JSON.stringify({
    folders: state.folders.map((f) => f.path),
    model: state.model,
    threshold: state.threshold,
    parallel: state.parallel,
    mode: state.mode,
    includeSubfolders: state.includeSubfolders,
    hfToken: state.hfToken,
  }));
}

async function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('bt3-settings')); } catch { /* fresh */ }
  if (!saved) return;
  state.model = saved.model ?? 'both';
  state.threshold = saved.threshold ?? 0.1;
  state.parallel = saved.parallel ?? 4;
  state.mode = saved.mode ?? 'all';
  state.includeSubfolders = saved.includeSubfolders ?? true;
  state.hfToken = saved.hfToken ?? '';

  $('threshold').value = state.threshold;
  $('parallel').value = state.parallel;
  $('includeSubfolders').checked = state.includeSubfolders;
  $('hfToken').value = state.hfToken;
  syncModelUI(); syncModeUI(); syncRangeLabels();

  for (const p of saved.folders ?? []) await addFolder(p);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
async function addFolder(folderPath) {
  if (state.folders.some((f) => f.path === folderPath)) return;
  const entry = { path: folderPath, imageCount: null, jsonCount: null };
  state.folders.push(entry);
  renderFolders();
  const info = await window.api.analyzeFolder(folderPath);
  if (!info.error) {
    entry.imageCount = info.imageCount;
    entry.jsonCount = info.jsonCount;
  }
  renderFolders();
  saveSettings();
}

function renderFolders() {
  const list = $('folderList');
  list.innerHTML = '';
  $('folderEmpty').style.display = state.folders.length ? 'none' : 'block';

  for (const f of state.folders) {
    const item = document.createElement('div');
    item.className = 'folder-item';

    const info = document.createElement('div');
    info.className = 'folder-info';
    const name = document.createElement('div');
    name.className = 'folder-name';
    name.textContent = f.path;
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'folder-meta';
    meta.textContent = f.imageCount === null
      ? 'analyzing...'
      : `${f.imageCount} images · ${f.jsonCount} tagged`;
    info.append(name, meta);

    const rm = document.createElement('button');
    rm.className = 'folder-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.disabled = state.running;
    rm.onclick = () => {
      state.folders = state.folders.filter((x) => x.path !== f.path);
      renderFolders(); saveSettings(); updateStartButton();
    };

    item.append(info, rm);
    list.appendChild(item);
  }
  updateStartButton();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function syncModelUI() {
  document.querySelectorAll('.model-opt').forEach((b) =>
    b.classList.toggle('active', b.dataset.model === state.model));
}
function syncModeUI() {
  document.querySelectorAll('.seg-opt').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === state.mode));
  $('modeHint').textContent = MODE_HINTS[state.mode];
}
function syncRangeLabels() {
  $('thresholdVal').textContent = Number(state.threshold).toFixed(2);
  $('parallelVal').textContent = String(state.parallel);
}
function updateStartButton() {
  $('startBtn').disabled = state.running || state.folders.length === 0;
}
function setRunning(running) {
  state.running = running;
  updateStartButton();
  $('pauseBtn').disabled = !running;
  $('cancelBtn').disabled = !running;
  $('addFoldersBtn').disabled = running;
  document.querySelectorAll('.model-opt, .seg-opt').forEach((b) => { b.disabled = running; });
  $('threshold').disabled = running;
  $('parallel').disabled = running;
  $('includeSubfolders').disabled = running;
  $('hfToken').disabled = running;
  renderFolders();
}

$('addFoldersBtn').onclick = async () => {
  const paths = await window.api.selectFolders();
  for (const p of paths) await addFolder(p);
};

document.querySelectorAll('.model-opt').forEach((b) => {
  b.onclick = () => { state.model = b.dataset.model; syncModelUI(); saveSettings(); };
});
document.querySelectorAll('.seg-opt').forEach((b) => {
  b.onclick = () => { state.mode = b.dataset.mode; syncModeUI(); saveSettings(); };
});
$('threshold').oninput = (e) => { state.threshold = Number(e.target.value); syncRangeLabels(); saveSettings(); };
$('parallel').oninput = (e) => { state.parallel = Number(e.target.value); syncRangeLabels(); saveSettings(); };
$('includeSubfolders').onchange = (e) => { state.includeSubfolders = e.target.checked; saveSettings(); };
$('hfToken').onchange = (e) => { state.hfToken = e.target.value.trim(); saveSettings(); };

$('pauseBtn').onclick = () => window.api.togglePause();
$('cancelBtn').onclick = () => window.api.cancelJob();

// ---------------------------------------------------------------------------
// Log & activity
// ---------------------------------------------------------------------------
const MAX_LOG_LINES = 800;
const MAX_ACTIVITY_ITEMS = 60;

function addLog(message, type = 'info') {
  const view = $('logView');
  const line = document.createElement('div');
  line.className = type;
  line.textContent = message;
  view.appendChild(line);
  while (view.childNodes.length > MAX_LOG_LINES) view.removeChild(view.firstChild);
  if ($('autoScroll').checked) view.scrollTop = view.scrollHeight;
}

function addActivity({ state: st, file, topTags, tagCount, error }) {
  if (st === 'start') return; // only show completions to keep the feed calm
  const feed = $('activityFeed');
  const item = document.createElement('div');
  item.className = 'act-item' + (st === 'fail' ? ' fail' : '');

  const fileEl = document.createElement('span');
  fileEl.className = 'act-file';
  fileEl.textContent = file;
  fileEl.title = file;

  const tagsEl = document.createElement('span');
  tagsEl.className = 'act-tags';
  tagsEl.textContent = st === 'fail'
    ? (error || 'failed')
    : `${tagCount} tags — ${(topTags || []).join(', ')}`;

  item.append(fileEl, tagsEl);
  feed.prepend(item);
  while (feed.childNodes.length > MAX_ACTIVITY_ITEMS) feed.removeChild(feed.lastChild);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------
let jobStart = 0;

function updateProgress(p) {
  $('doneCount').textContent = p.done;
  $('totalCount').textContent = p.total;
  $('statSuccess').textContent = p.success;
  $('statFailed').textContent = p.failed;
  $('statSkipped').textContent = p.skipped;
  const pct = p.total > 0 ? (p.done / p.total) * 100 : 0;
  $('barFill').style.width = `${pct}%`;

  const elapsed = (Date.now() - jobStart) / 1000;
  if (p.done > 2 && elapsed > 2) {
    const rate = p.done / elapsed;
    $('statRate').textContent = rate.toFixed(2);
    const remaining = p.total - p.done;
    const etaSec = remaining / rate;
    $('statEta').textContent = etaSec > 3600
      ? `${(etaSec / 3600).toFixed(1)}h`
      : etaSec > 60 ? `${Math.round(etaSec / 60)}m` : `${Math.round(etaSec)}s`;
  }
}

const PHASE_LABELS = {
  idle: 'Idle',
  warmup: 'Loading models...',
  scanning: 'Scanning folders...',
  tagging: 'Tagging',
};

// ---------------------------------------------------------------------------
// IPC events
// ---------------------------------------------------------------------------
window.api.on('log', ({ message, type }) => addLog(message, type));
window.api.on('progress', updateProgress);
window.api.on('activity', addActivity);
window.api.on('scan-progress', (msg) => { $('folderNow').textContent = msg; });
window.api.on('current-folder', ({ index, total, folderPath }) => {
  $('folderNow').textContent = `Folder ${index}/${total}: ${folderPath}`;
});
window.api.on('job-phase', ({ phase }) => {
  $('phaseLabel').textContent = PHASE_LABELS[phase] ?? phase;
  if (phase === 'idle') $('folderNow').textContent = '';
});
window.api.on('pause-state', (paused) => {
  state.paused = paused;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('phaseLabel').textContent = paused ? 'Paused' : PHASE_LABELS.tagging;
});
window.api.on('worker-state', (w) => {
  $('workerDot').className = 'dot' + (w.alive ? ' on' : '');
  $('workerLabel').textContent = w.alive
    ? `worker online · ${w.provider === 'dml' ? 'DirectML GPU' : w.provider === 'gpu' ? 'CUDA GPU' : 'CPU'}`
    : 'worker offline';
});
window.api.on('setup-state', ({ state: st, message }) => {
  const overlay = $('setupOverlay');
  if (st === 'installing') {
    overlay.classList.remove('hidden');
    if (message) {
      $('setupMessage').textContent = 'Setting up the Python environment — one time only.';
      const logEl = $('setupLog');
      logEl.textContent += message + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
  } else if (st === 'ready' || st === 'error') {
    overlay.classList.add('hidden');
    if (st === 'error') addLog(`Setup failed: ${message}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
$('startBtn').onclick = async () => {
  if (state.running || !state.folders.length) return;
  setRunning(true);
  jobStart = Date.now();
  $('statRate').textContent = '–';
  $('statEta').textContent = '–';
  $('activityFeed').innerHTML = '';
  updateProgress({ done: 0, total: 0, success: 0, failed: 0, skipped: 0 });

  try {
    const result = await window.api.runJob({
      folders: state.folders.map((f) => f.path),
      model: state.model,
      threshold: state.threshold,
      parallel: state.parallel,
      processMode: state.mode,
      includeSubfolders: state.includeSubfolders,
      hfToken: state.hfToken,
    });
    addLog(result.canceled
      ? `Job canceled — ${result.success} tagged before stopping.`
      : `Job complete — ${result.success} tagged, ${result.failed} failed, ${result.skipped} skipped.`,
    result.canceled ? 'warning' : 'success');
  } catch (err) {
    addLog(`Job error: ${err.message}`, 'error');
  } finally {
    setRunning(false);
    $('pauseBtn').textContent = 'Pause';
    $('phaseLabel').textContent = 'Idle';
    // refresh folder tag counts
    for (const f of state.folders) {
      const info = await window.api.analyzeFolder(f.path);
      if (!info.error) { f.imageCount = info.imageCount; f.jsonCount = info.jsonCount; }
    }
    renderFolders();
  }
};

// ---------------------------------------------------------------------------
// Boot: restore settings, then bring the worker up in the background so the
// first job doesn't pay the startup cost.
// ---------------------------------------------------------------------------
(async () => {
  await loadSettings();
  addLog('Booru Tagger V3 ready.', 'info');
  const res = await window.api.startWorker();
  if (!res.ok) addLog(`Worker startup failed: ${res.error}`, 'error');
})();
