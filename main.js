// Booru Suite — Electron main process.
// One window, four tools: Tagger (Python GPU worker) + the Eagle Toolkit's
// Renamer, Tag Merger and Eagle Sync (pure Node). Each tool keeps its own job
// state, so a sync can run while tagging is in progress.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');

// One data folder for `npm start` and the installed build alike (settings,
// sync history, hash database): %APPDATA%\booru-suite.
app.setPath('userData', path.join(app.getPath('appData'), 'booru-suite'));

const { registerTagger } = require('./lib/ipcTagger');
const { registerToolkit } = require('./lib/ipcToolkit');
const { resolveDataRoot, migrateLegacyData } = require('./lib/dataRoot');

let mainWindow = null;
const pendingMessages = []; // logged before the window existed

const ctx = {
  win: () => mainWindow,
  dataRoot: null, // set once the app is ready
  send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  },
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d1016',
    autoHideMenuBar: true,
    title: 'Booru Suite',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    for (const m of pendingMessages.splice(0)) ctx.send('tk:log', m);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Shared IPC
// ---------------------------------------------------------------------------
ipcMain.handle('select-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder(s)',
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

const tagger = registerTagger(ctx);
const toolkit = registerToolkit(ctx);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  ctx.dataRoot = resolveDataRoot(app);
  try {
    const migrated = await migrateLegacyData(app, __dirname, ctx.dataRoot);
    if (migrated.length) {
      pendingMessages.push({ message: `Imported data from the old Eagle Toolkit: ${migrated.join(', ')}`, type: 'success' });
    }
  } catch (err) {
    pendingMessages.push({ message: `Couldn't import old Eagle Toolkit data: ${err.message}`, type: 'warning' });
  }
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// On quit: stop jobs cleanly. A running Eagle tool finishes its current
// batch (so everything Eagle accepted is recorded for Verify/Undo) before the
// app exits; the Tagger worker is shut down.
let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting) return;
  const busy = toolkit.isRunning() || tagger.hasWorker();
  if (!busy) return;
  event.preventDefault();
  quitting = true;
  toolkit.cancel();
  const deadline = Date.now() + 60000;
  while (toolkit.isRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await tagger.shutdown();
  app.quit();
});
