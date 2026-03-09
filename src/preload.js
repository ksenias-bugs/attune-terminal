const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('attune', {
  getDefaultDirectory: () => ipcRenderer.invoke('get-default-directory'),
  getUsername: () => ipcRenderer.invoke('get-username'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  getRecentSessions: (directory) =>
    ipcRenderer.invoke('get-recent-sessions', { directory }),

  selectFile: () => ipcRenderer.invoke('select-file'),

  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  createPty: (id, directory, command) =>
    ipcRenderer.invoke('create-pty', { id, directory, command }),

  sendInput: (id, data) => ipcRenderer.send('pty-input', { id, data }),

  resizePty: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),

  destroyPty: (id) => ipcRenderer.send('pty-destroy', { id }),

  onPtyData: (id, callback) => {
    const channel = `pty-data-${id}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  onPtyExit: (id, callback) => {
    const channel = `pty-exit-${id}`;
    const listener = (_event, code) => callback(code);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
