// Eagle Toolkit tools (Renamer, Tag Merger, Eagle Sync) — IPC handlers.
// All channels are prefixed "tk:" so they never collide with the Tagger's.
const { dialog, ipcMain } = require('electron');
const path = require('path');

const { Renamer } = require('./renamer');
const { Merger } = require('./merger');
const { EagleSync } = require('./sync');

function registerToolkit(ctx) {
  const send = (channel, payload) => ctx.send(`tk:${channel}`, payload);
  const log = (message, type = 'info') => send('log', { message, type });
  const handle = (channel, fn) => ipcMain.handle(`tk:${channel}`, fn);
  const on = (channel, fn) => ipcMain.on(`tk:${channel}`, fn);

  let job = { running: false, paused: false, canceled: false };
  let eagleSync = null; // keeps the last scan's plan between Scan and Import
  const getSync = () => (eagleSync ||= new EagleSync(ctx.dataRoot));

  on('toggle-pause', () => {
    if (!job.running) return;
    job.paused = !job.paused;
    send('pause-state', job.paused);
    log(job.paused ? 'Paused.' : 'Resumed.');
  });

  on('cancel-job', () => {
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

  handle('run-rename', async (_e, opts) => {
    if (job.running) throw new Error('A job is already running.');
    job = { running: true, paused: false, canceled: false };
    try {
      log(`=== Rename start: ${opts.folders.length} folder(s), subfolders=${opts.includeSubfolders} ===`);
      const renamer = new Renamer(path.join(ctx.dataRoot, 'rename_history.ndjson'));
      const stats = await renamer.run(opts, jobCallbacks());
      log(`=== Rename done: ${stats.renamed} renamed, ${stats.skipped} skipped, ${stats.failed} failed ===`,
        stats.failed > 0 ? 'warning' : 'success');
      return { ...stats, canceled: job.canceled };
    } finally {
      job.running = false;
      send('job-phase', { phase: 'idle' });
    }
  });

  handle('run-merge', async (_e, opts) => {
    if (job.running) throw new Error('A job is already running.');
    job = { running: true, paused: false, canceled: false };
    try {
      log(`=== Merge start: ${opts.tagFolders.length} tag folder(s), ${opts.metadataFolders.length} Eagle folder(s), mode=${opts.mode}, threshold=${opts.threshold} ===`);
      const merger = new Merger(
        path.join(ctx.dataRoot, 'merge_processed.ndjson'),
        path.join(ctx.dataRoot, 'processed.log'),
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
  // Eagle Sync
  // ---------------------------------------------------------------------------
  handle('sync-status', (_e, opts) => EagleSync.status(opts || {}));

  handle('run-sync-scan', async (_e, opts) => {
    if (job.running) throw new Error('A job is already running.');
    job = { running: true, paused: false, canceled: false };
    try {
      log(`=== Sync scan: ${opts.sources.length} source folder(s), match=${opts.matchMode}, mapping=${opts.mapping} ===`);
      const summary = await getSync().scan(opts, jobCallbacks());
      if (!summary) log('Scan canceled.', 'warning');
      return summary ? { ...summary, canceled: false } : { canceled: true };
    } finally {
      job.running = false;
      send('job-phase', { phase: 'idle' });
    }
  });

  handle('run-sync-execute', async (_e, { selected, overrides }) => {
    if (job.running) throw new Error('A job is already running.');
    const summary = getSync().summarize();
    if (!summary) throw new Error('Scan first.');

    // Ask before creating folders in Eagle.
    const chosen = new Set(selected);
    const missing = summary.rows.filter((r) => chosen.has(r.key) && r.match === 'missing');
    let createKeys = [];
    if (missing.length) {
      const list = missing.slice(0, 15).map((r) => `  •  ${r.createPath || r.eaglePath}   (${r.newFiles} new)`).join('\n')
        + (missing.length > 15 ? `\n  …and ${missing.length - 15} more` : '');
      const { response } = await dialog.showMessageBox(ctx.win(), {
        type: 'question',
        title: 'Create folders in Eagle?',
        message: `Eagle doesn't have ${missing.length === 1 ? 'this folder' : `these ${missing.length} folders`} yet:`,
        detail: `${list}\n\nCreate ${missing.length === 1 ? 'it' : 'them'} in Eagle (same names, same nesting) and import into ${missing.length === 1 ? 'it' : 'them'}?`,
        buttons: ['Create & import', 'Skip these folders', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return { canceled: true, aborted: true };
      if (response === 0) createKeys = missing.map((r) => r.key);
    }

    job = { running: true, paused: false, canceled: false };
    try {
      log(`=== Sync import: ${selected.length} folder(s) selected ===`);
      const stats = await getSync().execute({ selected, createKeys, overrides }, jobCallbacks());
      log(`=== Sync done: ${stats.imported} imported (${stats.verified} verified), ${stats.filed} filed into folders, ${stats.foldersCreated} folder(s) created, ${stats.failed} failed ===`,
        stats.failed > 0 || stats.mismatched > 0 ? 'warning' : 'success');
      return { ...stats, canceled: job.canceled };
    } finally {
      job.running = false;
      send('job-phase', { phase: 'idle' });
    }
  });

  handle('run-sync-verify', async (_e, conn) => {
    if (job.running) throw new Error('A job is already running.');
    const runPath = await getSync().lastRunPath();
    if (!runPath) { log('No sync run with imports to verify.', 'warning'); return { canceled: true, aborted: true }; }
    job = { running: true, paused: false, canceled: false };
    try {
      return await getSync().verifyRun(runPath, conn || {}, jobCallbacks());
    } finally {
      job.running = false;
      send('job-phase', { phase: 'idle' });
    }
  });

  handle('run-sync-undo', async (_e, conn) => {
    if (job.running) throw new Error('A job is already running.');
    const info = await getSync().describeRun();
    if (!info) { log('No sync run to undo.', 'warning'); return { canceled: true, aborted: true }; }
    const when = info.at ? new Date(info.at).toLocaleString() : 'unknown time';
    const { response } = await dialog.showMessageBox(ctx.win(), {
      type: 'warning',
      title: 'Undo last sync?',
      message: `Undo the sync from ${when}?`,
      detail: `• Remove ${info.filed} folder assignment(s) it added to existing items (the items themselves stay)\n`
        + `• Move ${info.imported} item(s) it imported to Eagle's trash (you can restore them from there)\n`
        + `• List the ${info.foldersCreated.length} folder(s) it created so you can delete them in Eagle\n\n`
        + 'Your PC files are not touched.',
      buttons: ['Undo', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return { canceled: true, aborted: true };
    job = { running: true, paused: false, canceled: false };
    try {
      log(`=== Undo sync run: ${info.runPath} ===`);
      return await getSync().undoRun(info.runPath, conn || {}, jobCallbacks());
    } finally {
      job.running = false;
      send('job-phase', { phase: 'idle' });
    }
  });

  return {
    isRunning: () => job.running,
    cancel: () => { job.canceled = true; },
  };
}

module.exports = { registerToolkit };
