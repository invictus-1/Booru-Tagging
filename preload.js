const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (allowed, prefix = '') => (channel, handler) => {
  if (!allowed.has(channel)) return;
  ipcRenderer.on(prefix + channel, (_e, payload) => handler(payload));
};

// Tagger
contextBridge.exposeInMainWorld('api', {
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  analyzeFolder: (p) => ipcRenderer.invoke('analyze-folder', p),
  envStatus: () => ipcRenderer.invoke('env-status'),
  startWorker: () => ipcRenderer.invoke('start-worker'),
  runJob: (opts) => ipcRenderer.invoke('run-job', opts),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  cancelJob: () => ipcRenderer.send('cancel-job'),
  on: subscribe(new Set([
    'log', 'setup-state', 'worker-state', 'job-phase', 'scan-progress',
    'progress', 'current-folder', 'activity', 'pause-state',
  ])),
});

// Renamer / Tag Merger / Eagle Sync
contextBridge.exposeInMainWorld('tk', {
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  runRename: (opts) => ipcRenderer.invoke('tk:run-rename', opts),
  runMerge: (opts) => ipcRenderer.invoke('tk:run-merge', opts),
  syncStatus: (opts) => ipcRenderer.invoke('tk:sync-status', opts),
  runSyncScan: (opts) => ipcRenderer.invoke('tk:run-sync-scan', opts),
  runSyncExecute: (opts) => ipcRenderer.invoke('tk:run-sync-execute', opts),
  runSyncUndo: (conn) => ipcRenderer.invoke('tk:run-sync-undo', conn),
  runSyncVerify: (conn) => ipcRenderer.invoke('tk:run-sync-verify', conn),
  togglePause: () => ipcRenderer.send('tk:toggle-pause'),
  cancelJob: () => ipcRenderer.send('tk:cancel-job'),
  on: subscribe(new Set(['log', 'progress', 'pause-state', 'job-phase']), 'tk:'),
});
