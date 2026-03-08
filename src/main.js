const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const sessions = new Map();
let mainWindow;

function getDefaultDirectory() {
  const basePath = path.join(os.homedir(), 'Library', 'CloudStorage');
  try {
    const entries = fs.readdirSync(basePath);
    const gdriveDir = entries.find(
      (e) => e.startsWith('GoogleDrive-') && e.includes('@attune.co')
    );
    if (gdriveDir) {
      const teamResources = path.join(basePath, gdriveDir, 'Shared drives', 'Team Resources');
      if (fs.existsSync(teamResources)) {
        return teamResources;
      }
    }
  } catch (e) {
    // Google Drive not available
  }
  return os.homedir();
}

function getUsername() {
  const basePath = path.join(os.homedir(), 'Library', 'CloudStorage');
  try {
    const entries = fs.readdirSync(basePath);
    const gdriveDir = entries.find(
      (e) => e.startsWith('GoogleDrive-') && e.includes('@attune.co')
    );
    if (gdriveDir) {
      const match = gdriveDir.match(/GoogleDrive-(.+?)@attune\.co/);
      if (match) return match[1];
    }
  } catch (e) {}
  return os.userInfo().username;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#12131e',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Cmd+Option+I to toggle DevTools
  const { globalShortcut } = require('electron');
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.alt && input.key === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// IPC: Get defaults
ipcMain.handle('get-default-directory', () => getDefaultDirectory());
ipcMain.handle('get-username', () => getUsername());

// IPC: Directory picker
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: getDefaultDirectory(),
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// IPC: Create PTY session
ipcMain.handle('create-pty', (event, { id, directory, autoLaunch }) => {
  const shell = process.env.SHELL || '/bin/zsh';

  const term = pty.spawn(shell, ['--login'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: directory,
    env: { ...process.env },
  });

  sessions.set(id, term);

  term.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-data-${id}`, data);
    }
  });

  term.onExit(({ exitCode }) => {
    sessions.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-exit-${id}`, exitCode);
    }
  });

  // Auto-launch claude after shell initializes
  if (autoLaunch !== false) {
    setTimeout(() => {
      if (sessions.has(id)) {
        term.write('claude\r');
      }
    }, 500);
  }

  return true;
});

// IPC: Send input to PTY
ipcMain.on('pty-input', (event, { id, data }) => {
  const term = sessions.get(id);
  if (term) term.write(data);
});

// IPC: Resize PTY
ipcMain.on('pty-resize', (event, { id, cols, rows }) => {
  const term = sessions.get(id);
  if (term) {
    try {
      term.resize(cols, rows);
    } catch (e) {
      // PTY might already be closed
    }
  }
});

// IPC: Destroy PTY
ipcMain.on('pty-destroy', (event, { id }) => {
  const term = sessions.get(id);
  if (term) {
    term.kill();
    sessions.delete(id);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const [id, term] of sessions) {
    term.kill();
  }
  sessions.clear();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
