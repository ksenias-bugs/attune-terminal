import { TerminalSession } from './terminal.js';
import { Sidebar } from './sidebar.js';

class AttuneApp {
  constructor() {
    this.sessions = new Map();
    this.activeSessionId = null;
    this.sidebar = null;
    this.defaultDirectory = null;
    this.tabCounter = 0;
  }

  async init() {
    this.defaultDirectory = await window.attune.getDefaultDirectory();

    // Launcher elements
    const dirPathEl = document.getElementById('directory-path');
    const btnChangeDir = document.getElementById('btn-change-dir');
    const btnStart = document.getElementById('btn-start');

    // Show default directory (shortened for display)
    dirPathEl.textContent = this.shortenPath(this.defaultDirectory);
    dirPathEl.title = this.defaultDirectory;

    btnChangeDir.addEventListener('click', async () => {
      const dir = await window.attune.selectDirectory();
      if (dir) {
        this.defaultDirectory = dir;
        dirPathEl.textContent = this.shortenPath(dir);
        dirPathEl.title = dir;
      }
    });

    btnStart.addEventListener('click', () => {
      this.launchSession(this.defaultDirectory);
    });

    // New tab button
    document.getElementById('btn-new-tab').addEventListener('click', () => {
      this.showDirectoryPickerForNewTab();
    });

    // Keyboard shortcut: Cmd+T for new tab
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault();
        this.showDirectoryPickerForNewTab();
      }
      if (e.metaKey && e.key === 'w') {
        e.preventDefault();
        if (this.activeSessionId) {
          this.closeSession(this.activeSessionId);
        }
      }
    });
  }

  launchSession(directory) {
    // Hide launcher, show app
    document.getElementById('launcher').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    // Initialize sidebar on first launch
    if (!this.sidebar) {
      this.sidebar = new Sidebar((command) => {
        const session = this.sessions.get(this.activeSessionId);
        if (session) {
          session.terminal.sendCommand(command);
          session.terminal.focus();
        }
      });
    }

    this.createSession(directory);
  }

  createSession(directory) {
    const id = `session-${++this.tabCounter}`;
    const container = document.createElement('div');
    container.id = `terminal-${id}`;
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.display = 'none';

    document.getElementById('terminal-container').appendChild(container);

    const terminal = new TerminalSession(id, directory, container, (status, elapsed) => {
      if (id === this.activeSessionId) {
        this.sidebar.updateStatus(status, elapsed);
      }
      this.updateTabStatus(id, status);
      this.updateSessionsList();
    });

    this.sessions.set(id, { terminal, directory, startTime: Date.now(), status: 'launching' });
    this.addTab(id, directory);
    this.switchToSession(id);
    terminal.start();
  }

  addTab(id, directory) {
    const tabsEl = document.getElementById('tabs');
    const dirName = directory.split('/').pop() || directory;

    const tab = document.createElement('div');
    tab.className = 'tab active';
    tab.dataset.id = id;
    tab.innerHTML = `
      <div class="tab-status working"></div>
      <span class="tab-name">${dirName}</span>
      <button class="tab-close" title="Close tab">&times;</button>
    `;

    tab.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) {
        this.switchToSession(id);
      }
    });

    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSession(id);
    });

    tabsEl.appendChild(tab);
  }

  switchToSession(id) {
    // Deactivate current
    if (this.activeSessionId) {
      const prevContainer = document.getElementById(`terminal-${this.activeSessionId}`);
      if (prevContainer) prevContainer.style.display = 'none';
    }

    // Activate new
    this.activeSessionId = id;
    const container = document.getElementById(`terminal-${id}`);
    if (container) container.style.display = 'block';

    // Update tab styling
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.id === id);
    });

    // Focus terminal and update sidebar
    const session = this.sessions.get(id);
    if (session) {
      session.terminal.focus();
      this.sidebar.updateStatus(session.terminal.status, session.terminal.getElapsed());
      this.updateSessionsList();
    }
  }

  closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    session.terminal.destroy();
    this.sessions.delete(id);

    // Remove tab
    const tab = document.querySelector(`.tab[data-id="${id}"]`);
    if (tab) tab.remove();

    // Remove terminal container
    const container = document.getElementById(`terminal-${id}`);
    if (container) container.remove();

    // Switch to another session or show launcher
    if (this.sessions.size > 0) {
      const nextId = this.sessions.keys().next().value;
      this.switchToSession(nextId);
    } else {
      this.activeSessionId = null;
      document.getElementById('app-container').classList.add('hidden');
      document.getElementById('launcher').classList.remove('hidden');
    }

    this.updateSessionsList();
  }

  updateTabStatus(id, status) {
    const tab = document.querySelector(`.tab[data-id="${id}"]`);
    if (!tab) return;

    const statusDot = tab.querySelector('.tab-status');
    statusDot.className = 'tab-status';
    if (status === 'waiting') statusDot.classList.add('waiting');
    else if (status === 'exited') { /* no extra class */ }
    else statusDot.classList.add('working');

    // Update stored status
    const session = this.sessions.get(id);
    if (session) session.status = status;
  }

  updateSessionsList() {
    if (!this.sidebar) return;
    const sessions = Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      directory: s.directory,
      startTime: s.startTime,
      status: s.terminal.status,
    }));
    this.sidebar.updateSessions(sessions, this.activeSessionId);
  }

  async showDirectoryPickerForNewTab() {
    const dir = await window.attune.selectDirectory();
    if (dir) {
      if (document.getElementById('launcher').classList.contains('hidden')) {
        this.createSession(dir);
      } else {
        this.launchSession(dir);
      }
    }
  }

  shortenPath(fullPath) {
    const home = fullPath.indexOf('/Users/');
    if (home === -1) return fullPath;

    // Shorten Google Drive paths
    const match = fullPath.match(/CloudStorage\/GoogleDrive-[^/]+\/(.+)/);
    if (match) return match[1];

    const match2 = fullPath.match(/Google Drive\/(.+)/);
    if (match2) return match2[1];

    return fullPath.replace(/^\/Users\/[^/]+/, '~');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AttuneApp();
  app.init();
});
