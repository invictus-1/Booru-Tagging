const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolders: () => ipcRenderer.invoke('select-folders'),
  runRename: (opts) => ipcRenderer.invoke('run-rename', opts),
  runMerge: (opts) => ipcRenderer.invoke('run-merge', opts),
  togglePause: () => ipcRenderer.send('toggle-pause'),
  cancelJob: () => ipcRenderer.send('cancel-job'),

  on: (channel, handler) => {
    const allowed = new Set(['log', 'progress', 'pause-state', 'job-phase']);
    if (!allowed.has(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => handler(payload));
  },
});
