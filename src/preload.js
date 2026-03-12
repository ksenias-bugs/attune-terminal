const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('attune', {
  getDefaultDirectory: () => ipcRenderer.invoke('get-default-directory'),
  getDefaultDirectoryStatus: () => ipcRenderer.invoke('get-default-directory-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  setDefaultDirectory: (dirPath) => ipcRenderer.invoke('set-default-directory', dirPath),
  getUsername: () => ipcRenderer.invoke('get-username'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  getRecentSessions: (directory) =>
    ipcRenderer.invoke('get-recent-sessions', { directory }),

  selectFile: () => ipcRenderer.invoke('select-file'),

  listDirectory: (dirPath) => ipcRenderer.invoke('list-directory', { dirPath }),

  saveSessionState: (state) => ipcRenderer.invoke('save-session-state', state),
  loadSessionState: () => ipcRenderer.invoke('load-session-state'),
  listSessionIds: (directory) =>
    ipcRenderer.invoke('list-session-ids', { directory }),
  getSessionPreview: (directory, sessionId) =>
    ipcRenderer.invoke('get-session-preview', { directory, sessionId }),

  notify: (title, body, type) => ipcRenderer.send('notify', { title, body, type }),

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
