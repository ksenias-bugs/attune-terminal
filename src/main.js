const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const notifier = require('node-notifier');

const sessions = new Map();
let mainWindow;

// Shared helper: extract the first real user message from a JSONL session file
function extractFirstUserMessage(filePath, maxLength = 150) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines.slice(0, 50)) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'user') continue;
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
        if (!text || /^<(command-name|local-command|tool_result)/.test(text.trim())) continue;
        return text.slice(0, maxLength);
      } catch (e) {}
    }
  } catch (e) { console.error('Failed to read session file:', e); }
  return null;
}

// Register notifier click handler once at module level (prevents listener leak)
notifier.on('click', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// ---- Config persistence ----

const configPath = path.join(app.getPath('userData'), 'attune-config.json');
let _configCache = null;

function readConfig() {
  if (_configCache) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    _configCache = {};
  }
  return _configCache;
}

function writeConfig(config) {
  _configCache = config;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to write config:', e);
  }
}

// ---- Window bounds persistence ----

function getSavedWindowBounds() {
  const config = readConfig();
  const bounds = config.windowBounds;
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' || typeof bounds.height !== 'number') {
    return null;
  }

  // Validate that the saved position is still visible on at least one display
  const displays = screen.getAllDisplays();
  const isVisible = displays.some((display) => {
    const { x, y, width, height } = display.bounds;
    // Check if at least 100px of the window is within this display
    return (
      bounds.x < x + width - 100 &&
      bounds.x + bounds.width > x + 100 &&
      bounds.y < y + height - 100 &&
      bounds.y + bounds.height > y + 100
    );
  });

  if (!isVisible) return null;

  // Clamp dimensions to minimums
  bounds.width = Math.max(bounds.width, 700);
  bounds.height = Math.max(bounds.height, 400);

  return bounds;
}

let saveBoundsTimeout = null;
function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout);
  saveBoundsTimeout = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    const config = readConfig();
    config.windowBounds = bounds;
    writeConfig(config);
  }, 500);
}

// ---- Default directory resolution ----

function getHardcodedAttunePath() {
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
  } catch (e) { console.error('Failed to resolve Attune shared drive path:', e); }
  return null;
}

function getDefaultDirectory() {
  const config = readConfig();

  // 1. Check saved default from config
  if (config.defaultDirectory) {
    if (fs.existsSync(config.defaultDirectory)) {
      return config.defaultDirectory;
    }
    // Saved path no longer exists — fall back to home and signal re-prompt
    return os.homedir();
  }

  // 2. No saved default — try hardcoded Attune path
  const attunePath = getHardcodedAttunePath();
  if (attunePath) {
    return attunePath;
  }

  // 3. Nothing found — return home directory
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
  } catch (e) { console.error('Failed to resolve username from Google Drive path:', e); }
  return os.userInfo().username;
}

// Convert directory path to Claude Code's project dir name
function getProjectDirName(dirPath) {
  return dirPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function createWindow() {
  const savedBounds = getSavedWindowBounds();

  const windowOptions = {
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
  };

  if (savedBounds) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
    windowOptions.width = savedBounds.width;
    windowOptions.height = savedBounds.height;
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Save window position and size on move/resize (debounced)
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  // Cmd+Option+I to toggle DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.alt && input.key === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Confirm before closing if there are active terminal sessions
  mainWindow.on('close', (event) => {
    if (sessions.size === 0) return;

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Close all sessions?',
      message: 'Close all sessions?',
      detail: 'All running sessions will be ended. Your tabs will be restored on next launch.',
    });

    if (choice === 1) {
      event.preventDefault();
    }
  });
}

// IPC: Get defaults
ipcMain.handle('get-default-directory', () => getDefaultDirectory());
ipcMain.handle('get-username', () => getUsername());

// IPC: Get app version (from package.json)
ipcMain.handle('get-app-version', () => app.getVersion());

// IPC: Last-seen version for walkthrough/what's-new popup
ipcMain.handle('get-last-seen-version', () => {
  const config = readConfig();
  return config.lastSeenVersion || null;
});

ipcMain.handle('set-last-seen-version', (event, version) => {
  const config = readConfig();
  config.lastSeenVersion = version;
  writeConfig(config);
  return true;
});

// IPC: Open URL in default browser (restricted to http/https)
ipcMain.handle('open-external-url', (event, url) => {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  } catch { return false; }
  return shell.openExternal(url);
});

// IPC: Check for updates via GitHub API (public repo, no auth needed)
ipcMain.handle('check-for-updates', async () => {
  try {
    const res = await fetch('https://api.github.com/repos/ksenias-bugs/attune-terminal/releases/latest', {
      headers: { 'User-Agent': 'attune-terminal' },
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, tagName: data.tag_name, htmlUrl: data.html_url };
  } catch {
    return { ok: false };
  }
});

// IPC: Check if a saved default directory exists in config (for first-launch detection)
ipcMain.handle('get-default-directory-status', () => {
  const config = readConfig();
  if (!config.defaultDirectory) {
    // No saved default — check if hardcoded Attune path exists
    const attunePath = getHardcodedAttunePath();
    return { hasSaved: false, hardcodedExists: !!attunePath };
  }
  const exists = fs.existsSync(config.defaultDirectory);
  return { hasSaved: true, savedExists: exists, savedPath: config.defaultDirectory };
});

// IPC: Save default directory to config
ipcMain.handle('set-default-directory', (event, dirPath) => {
  const config = readConfig();
  config.defaultDirectory = dirPath;
  writeConfig(config);
  return true;
});

// IPC: Save a directory to the recent directories list (max 10, most recent first, no duplicates)
ipcMain.handle('save-recent-directory', (event, dirPath) => {
  const config = readConfig();
  let recent = config.recentDirectories || [];
  // Remove duplicate if already in list
  recent = recent.filter((d) => d !== dirPath);
  // Add to front
  recent.unshift(dirPath);
  // Keep max 10
  recent = recent.slice(0, 10);
  config.recentDirectories = recent;
  writeConfig(config);
  return true;
});

// IPC: Get the recent directories list
ipcMain.handle('get-recent-directories', () => {
  const config = readConfig();
  return config.recentDirectories || [];
});

// IPC: Save/load session state to config file (localStorage is unreliable in Electron)
ipcMain.handle('save-session-state', (event, state) => {
  const config = readConfig();
  config.sessionState = state;
  writeConfig(config);
  return true;
});

ipcMain.handle('load-session-state', () => {
  const config = readConfig();
  return config.sessionState || null;
});

// IPC: List all session file IDs for a directory
ipcMain.handle('list-session-ids', async (event, { directory }) => {
  const projectDirName = getProjectDirName(directory);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectDirName);
  try {
    if (!fs.existsSync(projectDir)) return [];
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''));
  } catch (e) {
    return [];
  }
});

// IPC: Get session preview (first user message) for a specific session ID
ipcMain.handle('get-session-preview', async (event, { directory, sessionId }) => {
  const projectDirName = getProjectDirName(directory);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectDirName);
  const filePath = path.join(projectDir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return null;
  return extractFirstUserMessage(filePath, 150);
});

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
      .slice(0, 20);

    const result = [];
    for (const file of files) {
      const firstMessage = extractFirstUserMessage(file.path, 120);

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

// IPC: Search sessions across ALL directories
ipcMain.handle('search-all-sessions', async (event, { query }) => {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    try {
      await fs.promises.access(claudeProjectsDir);
    } catch {
      return [];
    }

    const dirEntries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true });
    const projectDirs = dirEntries.filter((d) => d.isDirectory());

    // Decode an encoded project dir name back to a real path
    // The encoding replaces / with - (and other non-alphanumeric chars with -)
    // Format: -Users-username-project-path
    const decodeProjectPath = async (encodedName) => {
      if (!encodedName.startsWith('-')) return null;
      const segments = encodedName.substring(1).split('-').filter(Boolean);
      if (segments.length === 0) return null;

      let currentPath = '/';
      let i = 0;
      while (i < segments.length) {
        // Try increasingly longer hyphenated names (for dirs with hyphens in their name)
        let matched = false;
        for (let span = segments.length - i; span >= 1; span--) {
          const candidate = segments.slice(i, i + span).join('-');
          const testPath = path.join(currentPath, candidate);
          try {
            await fs.promises.access(testPath);
            currentPath = testPath;
            i += span;
            matched = true;
            break;
          } catch (e) {}
        }
        if (!matched) {
          currentPath = path.join(currentPath, segments[i]);
          i++;
        }
      }
      return currentPath;
    };

    // Collect all sessions from all project directories
    const allSessions = [];

    for (const projectDir of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDir.name);
      const decodedPath = await decodeProjectPath(projectDir.name);

      let sessionFiles;
      try {
        const files = await fs.promises.readdir(projectPath);
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
        sessionFiles = [];
        for (const f of jsonlFiles) {
          const filePath = path.join(projectPath, f);
          try {
            const stat = await fs.promises.stat(filePath);
            sessionFiles.push({ name: f, path: filePath, mtime: stat.mtime });
          } catch (e) {}
        }
      } catch (e) {
        continue;
      }

      for (const file of sessionFiles) {
        const firstMessage = extractFirstUserMessage(file.path, 150);

        allSessions.push({
          sessionId: file.name.replace('.jsonl', ''),
          directory: decodedPath || projectDir.name,
          summary: firstMessage || '(empty session)',
          timestamp: file.mtime.toISOString(),
          projectPath: projectDir.name,
        });
      }
    }

    // Sort by most recent first
    allSessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // If query is empty, return the 20 most recent
    const searchQuery = (query || '').trim().toLowerCase();
    if (!searchQuery) {
      return allSessions.slice(0, 20);
    }

    // Filter by query (case-insensitive match on summary or directory)
    const filtered = allSessions.filter((s) =>
      s.summary.toLowerCase().includes(searchQuery) ||
      s.directory.toLowerCase().includes(searchQuery)
    );

    return filtered.slice(0, 100);
  } catch (e) {
    return [];
  }
});

// IPC: Send native macOS notification (only when window is not focused)
// type: 'approval' (needs attention — dock bounce) or 'waiting' (informational — no bounce)
ipcMain.on('notify', (event, { title, body, type }) => {
  if (mainWindow && mainWindow.isFocused()) return;

  notifier.notify(
    {
      title,
      message: body,
      sound: type === 'approval' ? 'default' : false,
      wait: true,
    },
    () => {} // no-op callback to suppress errors
  );

  // Bounce dock icon ONLY for approval — needs immediate attention
  // 'waiting' (task finished) is informational, no bounce
  if (app.dock && type === 'approval') {
    app.dock.bounce('critical');
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

// IPC: Read CLAUDE.md from a directory (or .claude/CLAUDE.md as fallback)
ipcMain.handle('read-claude-md', async (event, dirPath) => {
  try {
    // Try CLAUDE.md in the directory root first
    const primaryPath = path.join(dirPath, 'CLAUDE.md');
    if (fs.existsSync(primaryPath)) {
      return fs.readFileSync(primaryPath, 'utf8');
    }
    // Fallback: .claude/CLAUDE.md
    const fallbackPath = path.join(dirPath, '.claude', 'CLAUDE.md');
    if (fs.existsSync(fallbackPath)) {
      return fs.readFileSync(fallbackPath, 'utf8');
    }
    return null;
  } catch (e) {
    return null;
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
  // Validate command — only allow 'claude' with optional --resume/--continue
  const ALLOWED_CMD = /^claude(\s+--(resume|continue)(\s+[a-f0-9-]+)?)?$/;
  const cmd = command || 'claude';
  if (!ALLOWED_CMD.test(cmd)) {
    throw new Error('Invalid command');
  }

  // Validate directory exists and is actually a directory
  try {
    const dirStat = fs.statSync(directory);
    if (!dirStat.isDirectory()) {
      throw new Error('Invalid directory: not a directory');
    }
  } catch (e) {
    if (e.message.startsWith('Invalid')) throw e;
    throw new Error('Invalid directory: path does not exist');
  }

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

  // Auto-launch the validated command after shell initializes
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
    } catch (e) { console.error('Failed to resize PTY:', e); }
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
