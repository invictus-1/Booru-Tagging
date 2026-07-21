// Booru Tagger V3 — Electron main process.
// One Python GPU worker over stdio. No Docker, no ports, no health checks.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');

const { ensureEnvironment, isReady } = require('./lib/pythonEnv');
const { TagWorker } = require('./lib/worker');
const { buildPlan, analyzeFolder, appendLog } = require('./lib/scanner');

let mainWindow = null;
let worker = null;
let workerInfo = null; // {provider, models, ...} from hello
let job = { running: false, paused: false, canceled: false };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
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
function log(message, type = 'info') { send('log', { message, type }); }

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------
let startWorkerPromise = null;

function startWorker() {
  // Singleton: boot and a quick Start click must never spawn two workers.
  if (worker && worker.alive && workerInfo) return Promise.resolve(workerInfo);
  if (startWorkerPromise) return startWorkerPromise;
  startWorkerPromise = _startWorker().finally(() => { startWorkerPromise = null; });
  return startWorkerPromise;
}

async function _startWorker() {
  if (worker && worker.alive && workerInfo) return workerInfo;

  send('setup-state', { state: 'checking' });
  const pythonPath = await ensureEnvironment((msg) => {
    send('setup-state', { state: 'installing', message: msg });
    log(msg, 'setup');
  });

  send('setup-state', { state: 'starting' });
  worker = new TagWorker(pythonPath, {
    onLog: (line) => log(line, 'worker'),
    onExit: (code) => {
      workerInfo = null;
      if (job.running) {
        job.canceled = true;
        log(`Inference worker exited unexpectedly (code ${code}). Job stopped.`, 'error');
      }
      send('worker-state', { alive: false });
    },
  });
  worker.start();
  workerInfo = await worker.hello();
  send('worker-state', {
    alive: true,
    provider: workerInfo.provider,
    providers: workerInfo.providers,
    models: workerInfo.models,
    animetimmRepo: workerInfo.animetimmRepo,
  });
  send('setup-state', { state: 'ready' });
  log(`Worker ready — provider: ${workerInfo.provider}`, 'success');
  return workerInfo;
}

// ---------------------------------------------------------------------------
// IPC: folders & setup
// ---------------------------------------------------------------------------
ipcMain.handle('select-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select image folder(s)',
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('analyze-folder', (_e, folderPath) => analyzeFolder(folderPath));

ipcMain.handle('env-status', () => ({ ready: isReady() }));

ipcMain.handle('start-worker', async () => {
  try {
    return { ok: true, info: await startWorker() };
  } catch (err) {
    send('setup-state', { state: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.on('toggle-pause', () => {
  if (!job.running) return;
  job.paused = !job.paused;
  send('pause-state', job.paused);
  log(job.paused ? 'Paused.' : 'Resumed.', 'info');
});

ipcMain.on('cancel-job', () => {
  if (!job.running) return;
  job.canceled = true;
  log('Cancel requested — finishing in-flight images...', 'warning');
});

// ---------------------------------------------------------------------------
// IPC: the job
// ---------------------------------------------------------------------------
ipcMain.handle('run-job', async (_e, opts) => {
  const {
    folders, model, threshold, parallel, processMode, includeSubfolders, hfToken,
  } = opts;

  if (job.running) throw new Error('A job is already running.');
  job = { running: true, paused: false, canceled: false };

  const stats = { total: 0, done: 0, success: 0, failed: 0, skipped: 0, startedAt: Date.now() };

  try {
    await startWorker();

    log(`=== Job start: ${folders.length} folder(s), model=${model}, threshold=${threshold}, parallel=${parallel}, mode=${processMode} ===`);
    await worker.init(model, threshold, parallel, hfToken || null);

    // Warm up (first ever run downloads model weights — can take minutes)
    send('job-phase', { phase: 'warmup' });
    log('Loading model(s)... first run downloads weights, please wait.', 'info');
    const warm = await worker.warmup();
    if (!warm.ok) {
      if (/GatedRepoError|401/.test(warm.error || '')) {
        log('This model is gated on Hugging Face. Fix: (1) create a free account at huggingface.co, ' +
            '(2) open the model page and accept its terms, (3) create a Read token in Settings → Access Tokens, ' +
            '(4) paste it into the "HF token" field and start again.', 'warning');
      }
      throw new Error(`Model load failed: ${warm.error}`);
    }
    log('Model(s) loaded ✓', 'success');

    // Scan
    send('job-phase', { phase: 'scanning' });
    const { plan, totalImages } = await buildPlan(
      folders, processMode, includeSubfolders,
      (msg) => send('scan-progress', msg),
    );
    stats.total = totalImages;
    send('job-phase', { phase: 'tagging' });
    send('progress', { ...stats });
    log(`Scan complete: ${totalImages} image(s) targeted across ${plan.length} folder(s).`);

    if (totalImages === 0) return { ...stats, canceled: false };

    // Process folder by folder; sliding window of `parallel` in-flight requests.
    for (let f = 0; f < plan.length; f++) {
      if (job.canceled) break;
      const { folderPath, images } = plan[f];
      const jsonFolder = path.join(folderPath, 'Json');
      send('current-folder', { index: f + 1, total: plan.length, folderPath });

      const logEntries = [];
      let cursor = 0;
      const inflight = new Set();

      const dispatchOne = () => {
        const img = images[cursor++];
        const imagePath = path.join(folderPath, img);
        const jsonOut = path.join(jsonFolder, path.basename(img, path.extname(img)) + '.json');
        send('activity', { state: 'start', file: img });

        const p = worker.tag(imagePath, jsonOut)
          .then((res) => {
            const entry = {
              success: !!res.ok,
              imagePath,
              timestamp: new Date().toISOString(),
              status: res.ok ? 'success' : 'failed',
              ...(res.ok ? {} : { error: res.error }),
            };
            logEntries.push(entry);
            stats.done++;
            if (res.ok) {
              stats.success++;
              send('activity', { state: 'done', file: img, topTags: res.topTags, tagCount: res.tagCount });
            } else {
              stats.failed++;
              log(`✗ ${img}: ${res.error}`, 'error');
              send('activity', { state: 'fail', file: img, error: res.error });
            }
            send('progress', { ...stats });
          })
          .catch((err) => {
            logEntries.push({
              success: false, imagePath,
              timestamp: new Date().toISOString(),
              status: 'failed', error: err.message,
            });
            stats.done++; stats.failed++;
            send('progress', { ...stats });
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      };

      while (cursor < images.length || inflight.size > 0) {
        if (job.canceled) break;
        while (job.paused && !job.canceled) {
          await new Promise((r) => setTimeout(r, 200));
        }
        while (!job.paused && !job.canceled && cursor < images.length && inflight.size < parallel) {
          dispatchOne();
        }
        if (inflight.size > 0) await Promise.race(inflight);
      }
      if (inflight.size > 0) await Promise.allSettled([...inflight]);

      // Anything never dispatched (cancel) => skipped
      for (let i = cursor; i < images.length; i++) {
        stats.skipped++;
        logEntries.push({
          success: false,
          imagePath: path.join(folderPath, images[i]),
          timestamp: new Date().toISOString(),
          status: job.canceled ? 'canceled' : 'skipped',
          error: 'Not processed',
        });
      }

      try {
        await appendLog(folderPath, logEntries);
      } catch (err) {
        log(`Failed writing processed_log.json in ${path.basename(folderPath)}: ${err.message}`, 'error');
      }
      send('progress', { ...stats });
    }

    const secs = ((Date.now() - stats.startedAt) / 1000).toFixed(1);
    const rate = stats.done > 0 ? (stats.done / ((Date.now() - stats.startedAt) / 1000)).toFixed(2) : '0';
    log(`=== Done: ${stats.success} tagged, ${stats.failed} failed, ${stats.skipped} skipped — ${secs}s (${rate} img/s) ===`,
      stats.failed > 0 ? 'warning' : 'success');
    return { ...stats, canceled: job.canceled };
  } finally {
    job.running = false;
    send('job-phase', { phase: 'idle' });
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async (event) => {
  if (worker && worker.alive) {
    event.preventDefault();
    job.canceled = true;
    try { await worker.stop(); } catch { /* forced */ }
    worker = null;
    app.quit();
  }
});
