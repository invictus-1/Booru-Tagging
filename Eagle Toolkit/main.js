// Eagle Toolkit — Electron main process. Pure Node, no Python, no deps.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');

const { Renamer } = require('./lib/renamer');
const { Merger } = require('./lib/merger');

let mainWindow = null;
let job = { running: false, paused: false, canceled: false };

const DATA_ROOT = () => (app.isPackaged ? app.getPath('userData') : __dirname);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0d1016',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const log = (message, type = 'info') => send('log', { message, type });

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('select-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder(s)',
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.on('toggle-pause', () => {
  if (!job.running) return;
  job.paused = !job.paused;
  send('pause-state', job.paused);
  log(job.paused ? 'Paused.' : 'Resumed.');
});

ipcMain.on('cancel-job', () => {
  if (!job.running) return;
  job.canceled = true;
  log('Cancel requested — finishing in-flight work...', 'warning');
});

function jobCallbacks() {
  return {
    onProgress: (stats) => send('progress', stats),
    onLog: (message, type = 'info') => log(message, type),
    control: job,
  };
}

ipcMain.handle('run-rename', async (_e, opts) => {
  if (job.running) throw new Error('A job is already running.');
  job = { running: true, paused: false, canceled: false };
  try {
    log(`=== Rename start: ${opts.folders.length} folder(s), subfolders=${opts.includeSubfolders} ===`);
    const renamer = new Renamer(path.join(DATA_ROOT(), 'rename_history.ndjson'));
    const stats = await renamer.run(opts, jobCallbacks());
    log(`=== Rename done: ${stats.renamed} renamed, ${stats.skipped} skipped, ${stats.failed} failed ===`,
      stats.failed > 0 ? 'warning' : 'success');
    return { ...stats, canceled: job.canceled };
  } finally {
    job.running = false;
    send('job-phase', { phase: 'idle' });
  }
});

ipcMain.handle('run-merge', async (_e, opts) => {
  if (job.running) throw new Error('A job is already running.');
  job = { running: true, paused: false, canceled: false };
  try {
    log(`=== Merge start: ${opts.tagFolders.length} tag folder(s), ${opts.metadataFolders.length} Eagle folder(s), mode=${opts.mode}, threshold=${opts.threshold} ===`);
    const merger = new Merger(
      path.join(DATA_ROOT(), 'merge_processed.ndjson'),
      path.join(DATA_ROOT(), 'processed.log'),
    );
    const stats = await merger.run(opts, jobCallbacks());
    if (stats) {
      log(`=== Merge done: ${stats.updated} updated (+${stats.tagsAdded} tags), ${stats.unchanged} unchanged, ${stats.noMatch} no match, ${stats.failed} failed ===`,
        stats.failed > 0 ? 'warning' : 'success');
    } else {
      log('Merge canceled during scanning.', 'warning');
    }
    return stats ? { ...stats, canceled: job.canceled } : { canceled: true };
  } finally {
    job.running = false;
    send('job-phase', { phase: 'idle' });
  }
});

// ---------------------------------------------------------------------------
app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { job.canceled = true; });
