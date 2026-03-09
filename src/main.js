const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
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
  } catch (e) {}
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

// Convert directory path to Claude Code's project dir name
function getProjectDirName(dirPath) {
  return dirPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Cmd+Option+I to toggle DevTools
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

// IPC: Get recent Claude Code sessions for a directory
ipcMain.handle('get-recent-sessions', async (event, { directory }) => {
  const projectDirName = getProjectDirName(directory);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectDirName);

  try {
    if (!fs.existsSync(projectDir)) return [];

    const files = fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const filePath = path.join(projectDir, f);
        const stat = fs.statSync(filePath);
        return { name: f, path: filePath, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    const result = [];
    for (const file of files) {
      let firstMessage = '';
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines.slice(0, 50)) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== 'user') continue;
            // Skip meta messages (slash commands, local command output)
            if (obj.isMeta) continue;

            const msg = obj.message;
            if (!msg) continue;

            let text = '';
            if (typeof msg.content === 'string') {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textBlock = msg.content.find((b) => b.type === 'text');
              if (textBlock) text = textBlock.text;
            }

            // Skip system/command XML messages that aren't real user input
            if (!text || /^<(command-name|local-command|tool_result)/.test(text.trim())) continue;

            firstMessage = text.slice(0, 120);
            break;
          } catch (e) {}
        }
      } catch (e) {}

      result.push({
        id: file.name.replace('.jsonl', ''),
        timestamp: file.mtime.toISOString(),
        preview: firstMessage || '(empty session)',
      });
    }

    return result;
  } catch (e) {
    return [];
  }
});

// IPC: Send native macOS notification (only when window is not focused)
ipcMain.on('notify', (event, { title, body }) => {
  if (mainWindow && mainWindow.isFocused()) return;

  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();

  // Bounce dock icon for attention
  if (app.dock) {
    app.dock.bounce('informational');
  }
});

// IPC: List directory contents for file explorer
ipcMain.handle('list-directory', async (event, { dirPath }) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      // Skip hidden files/folders by default
      if (entry.name.startsWith('.')) continue;
      items.push({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      });
    }
    // Sort: folders first, then alphabetical
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return items;
  } catch (e) {
    return [];
  }
});

// IPC: File picker (insert path into terminal)
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return null;
  return result.filePaths;
});

// IPC: Create PTY session
ipcMain.handle('create-pty', (event, { id, directory, command }) => {
  const shell = process.env.SHELL || '/bin/zsh';

  // Clean env: remove CLAUDECODE so `claude` doesn't think it's nested
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const term = pty.spawn(shell, ['--login'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: directory,
    env: cleanEnv,
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

  // Auto-launch the specified command after shell initializes
  const cmd = command || 'claude';
  setTimeout(() => {
    if (sessions.has(id)) {
      term.write(cmd + '\r');
    }
  }, 500);

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
    } catch (e) {}
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
