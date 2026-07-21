const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  analyzeFolder: (p) => ipcRenderer.invoke('analyze-folder', p),
  envStatus: () => ipcRenderer.invoke('env-status'),
  startWorker: () => ipcRenderer.invoke('start-worker'),
  runJob: (opts) => ipcRenderer.invoke('run-job', opts),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  cancelJob: () => ipcRenderer.send('cancel-job'),

  on: (channel, handler) => {
    const allowed = new Set([
      'log', 'setup-state', 'worker-state', 'job-phase', 'scan-progress',
      'progress', 'current-folder', 'activity', 'pause-state',
    ]);
    if (!allowed.has(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => handler(payload));
  },
});
