// Eagle Toolkit — renderer logic (vanilla).
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  activeTab: 'rename',
  running: false,
  // folder lists keyed by container id
  lists: { renameFolders: [], tagFolders: [], metaFolders: [] },
  renameSubfolders: true,
  mergeMode: 'all',
  mergeThreshold: 0.35,
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
  }));
}

function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('et-settings')); } catch { /* fresh */ }
  if (!saved) return;
  state.lists = { renameFolders: [], tagFolders: [], metaFolders: [], ...saved.lists };
  state.renameSubfolders = saved.renameSubfolders ?? true;
  state.mergeMode = saved.mergeMode ?? 'all';
  state.mergeThreshold = saved.mergeThreshold ?? 0.35;

  $('renameSubfolders').checked = state.renameSubfolders;
  $('mergeThreshold').value = state.mergeThreshold;
  $('mergeThresholdVal').textContent = Number(state.mergeThreshold).toFixed(2);
  syncMergeModeUI();
  for (const key of Object.keys(state.lists)) renderList(key);
}

// ---------------------------------------------------------------------------
// Folder lists (generic: three lists share one renderer)
// ---------------------------------------------------------------------------
const EMPTY_IDS = {
  renameFolders: 'renameFoldersEmpty',
  tagFolders: 'tagFoldersEmpty',
  metaFolders: 'metaFoldersEmpty',
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
      renderList(key); saveSettings(); updateStartButtons();
    };

    item.append(name, rm);
    container.appendChild(item);
  }
  updateStartButtons();
}

document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.onclick = async () => {
    const key = btn.dataset.add;
    const paths = await window.api.selectFolders();
    for (const p of paths) {
      if (!state.lists[key].includes(p)) state.lists[key].push(p);
    }
    renderList(key); saveSettings();
  };
});

function updateStartButtons() {
  $('renameStartBtn').disabled = state.running || state.lists.renameFolders.length === 0;
  $('mergeStartBtn').disabled = state.running ||
    state.lists.tagFolders.length === 0 || state.lists.metaFolders.length === 0;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    if (state.running) return;
    state.activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('panel-rename').classList.toggle('hidden', state.activeTab !== 'rename');
    $('panel-merge').classList.toggle('hidden', state.activeTab !== 'merge');
  };
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('renameSubfolders').onchange = (e) => { state.renameSubfolders = e.target.checked; saveSettings(); };

function syncMergeModeUI() {
  document.querySelectorAll('#mergeModeSeg .seg-opt').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === state.mergeMode));
  $('mergeModeHint').textContent = MERGE_MODE_HINTS[state.mergeMode];
}
document.querySelectorAll('#mergeModeSeg .seg-opt').forEach((b) => {
  b.onclick = () => { state.mergeMode = b.dataset.mode; syncMergeModeUI(); saveSettings(); };
});

$('mergeThreshold').oninput = (e) => {
  state.mergeThreshold = Number(e.target.value);
  $('mergeThresholdVal').textContent = state.mergeThreshold.toFixed(2);
  saveSettings();
};

$('pauseBtn').onclick = () => window.api.togglePause();
$('cancelBtn').onclick = () => window.api.cancelJob();

function setRunning(running) {
  state.running = running;
  updateStartButtons();
  $('pauseBtn').disabled = !running;
  $('cancelBtn').disabled = !running;
  document.querySelectorAll('.tab, [data-add], #mergeModeSeg .seg-opt').forEach((b) => { b.disabled = running; });
  $('renameSubfolders').disabled = running;
  $('mergeThreshold').disabled = running;
  for (const key of Object.keys(state.lists)) renderList(key);
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

window.api.on('log', ({ message, type }) => addLog(message, type));
window.api.on('progress', (stats) => renderStats(currentTool, stats));
window.api.on('pause-state', (paused) => {
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('phaseLabel').textContent = paused ? 'Paused' : 'Working...';
});
window.api.on('job-phase', ({ phase }) => {
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
    if (result && result.canceled) addLog('Job canceled.', 'warning');
  } catch (err) {
    addLog(`Job error: ${err.message}`, 'error');
  } finally {
    setRunning(false);
    $('pauseBtn').textContent = 'Pause';
    $('phaseLabel').textContent = 'Idle';
  }
}

$('renameStartBtn').onclick = () => runJob('rename', () => window.api.runRename({
  folders: state.lists.renameFolders,
  includeSubfolders: state.renameSubfolders,
}));

$('mergeStartBtn').onclick = () => runJob('merge', () => window.api.runMerge({
  tagFolders: state.lists.tagFolders,
  metadataFolders: state.lists.metaFolders,
  mode: state.mergeMode,
  threshold: state.mergeThreshold,
}));

// ---------------------------------------------------------------------------
loadSettings();
addLog('Eagle Toolkit ready.');
addLog('Tip: close Eagle (or let it re-sync) before merging tags — Eagle caches metadata in memory.', 'warning');
