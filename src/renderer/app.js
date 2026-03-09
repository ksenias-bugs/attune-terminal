import { TerminalSession, getTerminalTheme } from './terminal.js';
import { Sidebar } from './sidebar.js';
import { FileExplorer } from './file-explorer.js';

class AttuneApp {
  constructor() {
    // Each tab: { id, state: 'launcher'|'terminal', directory, terminal, container, launcherEl }
    this.tabs = new Map();
    this.activeTabId = null;
    this.sidebar = null;
    this.fileExplorer = null;
    this.defaultDirectory = null;
    this.tabCounter = 0;
    this.isDark = false;
  }

  async init() {
    // Load saved theme preference
    const savedTheme = localStorage.getItem('attune-theme');
    if (savedTheme === 'dark') {
      this.isDark = true;
      document.body.setAttribute('data-theme', 'dark');
    }
    // Light is default — no data-theme attribute needed

    this.defaultDirectory = await window.attune.getDefaultDirectory();

    // Initialize sidebar
    this.sidebar = new Sidebar(
      (command) => {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.state === 'terminal' && tab.terminal) {
          tab.terminal.sendCommand(command);
          tab.terminal.focus();
        }
      },
      (sessionId) => {
        this.handleSessionClick(sessionId);
      }
    );

    // File explorer
    this.fileExplorer = new FileExplorer((filePath) => {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && tab.state === 'terminal' && tab.terminal) {
        window.attune.sendInput(tab.id, filePath);
        tab.terminal.focus();
      }
    });

    // File explorer toggle
    const fileExplorerCollapsed = localStorage.getItem('attune-file-explorer-collapsed') !== 'false';
    if (fileExplorerCollapsed) {
      document.body.classList.add('file-explorer-collapsed');
    }

    const toggleFileExplorer = () => {
      document.body.classList.toggle('file-explorer-collapsed');
      localStorage.setItem('attune-file-explorer-collapsed', document.body.classList.contains('file-explorer-collapsed'));
      setTimeout(() => {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.terminal) tab.terminal.focus();
      }, 250);
    };

    document.getElementById('btn-file-explorer-toggle').addEventListener('click', toggleFileExplorer);
    document.getElementById('btn-file-explorer-close').addEventListener('click', toggleFileExplorer);

    // Sidebar toggle
    const sidebarCollapsed = localStorage.getItem('attune-sidebar-collapsed') === 'true';
    if (sidebarCollapsed) {
      document.body.classList.add('sidebar-collapsed');
    }
    document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem('attune-sidebar-collapsed', document.body.classList.contains('sidebar-collapsed'));
      // Re-fit terminals after sidebar animation
      setTimeout(() => {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.terminal) tab.terminal.focus();
      }, 250);
    });

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });

    // New tab button
    document.getElementById('btn-new-tab').addEventListener('click', () => {
      this.createLauncherTab();
    });

    // Attach file button
    document.getElementById('btn-attach-file').addEventListener('click', () => {
      this.insertFilePath();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.metaKey && e.key === 't') {
        e.preventDefault();
        this.createLauncherTab();
      }
      if (e.metaKey && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) {
          this.closeTab(this.activeTabId);
        }
      }

      // Cmd+1 through Cmd+9: switch to tab by position
      if (e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const tabEls = document.querySelectorAll('#tabs .tab');
        if (tabEls.length > 0) {
          const index = e.key === '9' ? tabEls.length - 1 : Math.min(parseInt(e.key) - 1, tabEls.length - 1);
          const targetId = tabEls[index].dataset.id;
          this.switchToTab(targetId);
        }
      }

      // Cmd+Shift+[ : previous tab (wrap around)
      if (e.metaKey && e.shiftKey && e.key === '[') {
        e.preventDefault();
        this.switchToAdjacentTab(-1);
      }

      // Cmd+Shift+] : next tab (wrap around)
      if (e.metaKey && e.shiftKey && e.key === ']') {
        e.preventDefault();
        this.switchToAdjacentTab(1);
      }

      // Cmd+O : pick a file and insert path into terminal
      if (e.metaKey && e.key === 'o') {
        e.preventDefault();
        this.insertFilePath();
      }
    });

    // Create initial launcher tab
    this.createLauncherTab();
  }

  // ---- Theme ----

  toggleTheme() {
    this.isDark = !this.isDark;
    if (this.isDark) {
      document.body.setAttribute('data-theme', 'dark');
      localStorage.setItem('attune-theme', 'dark');
    } else {
      document.body.removeAttribute('data-theme');
      localStorage.setItem('attune-theme', 'light');
    }

    // Update all active terminal themes
    for (const [, tab] of this.tabs) {
      if (tab.state === 'terminal' && tab.terminal) {
        tab.terminal.setTheme(this.isDark);
      }
    }
  }

  // ---- Tab Management ----

  createLauncherTab() {
    const id = `tab-${++this.tabCounter}`;

    // Create the launcher DOM inside terminal-container
    const wrapper = document.createElement('div');
    wrapper.id = `tab-content-${id}`;
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.display = 'none';

    const launcherEl = this.buildLauncherElement(id);
    wrapper.appendChild(launcherEl);

    document.getElementById('terminal-container').appendChild(wrapper);

    this.tabs.set(id, {
      id,
      state: 'launcher',
      directory: this.defaultDirectory,
      terminal: null,
      container: wrapper,
      launcherEl,
    });

    this.addTabElement(id, 'New Session');
    this.switchToTab(id);

    // Load recent sessions and file explorer for the default directory
    this.sidebar.loadRecentSessions(this.defaultDirectory);
    this.fileExplorer.setDirectory(this.defaultDirectory);
  }

  buildLauncherElement(tabId) {
    const launcher = document.createElement('div');
    launcher.className = 'tab-launcher';

    const dirDisplay = this.shortenPath(this.defaultDirectory);
    const dirFull = this.defaultDirectory;

    launcher.innerHTML = `
      <div class="launcher-content">
        <div class="launcher-logo">
          <div class="logo-mark">A</div>
          <h1>Attune Terminal</h1>
          <p class="launcher-subtitle">Claude Code for your team</p>
        </div>

        <div class="launcher-directory">
          <label>Working Directory</label>
          <div class="directory-display">
            <span class="launcher-dir-path" title="${dirFull}">${dirDisplay}</span>
            <button class="btn-secondary launcher-btn-change">Change</button>
          </div>
        </div>

        <button class="btn-primary launcher-btn-start">Start Claude Code</button>

        <div class="launcher-resume">
          <div class="launcher-resume-header">Resume</div>
          <div class="launcher-resume-buttons">
            <button class="btn-resume launcher-btn-continue">
              Continue Last
              <span class="btn-resume-sub">Pick up where you left off</span>
            </button>
            <button class="btn-resume launcher-btn-browse">
              Browse Sessions
              <span class="btn-resume-sub">Choose from past sessions</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire up launcher buttons
    const dirPathEl = launcher.querySelector('.launcher-dir-path');
    const btnChange = launcher.querySelector('.launcher-btn-change');
    const btnStart = launcher.querySelector('.launcher-btn-start');
    const btnContinue = launcher.querySelector('.launcher-btn-continue');
    const btnBrowse = launcher.querySelector('.launcher-btn-browse');

    btnChange.addEventListener('click', async () => {
      const dir = await window.attune.selectDirectory();
      if (dir) {
        const tab = this.tabs.get(tabId);
        if (tab) tab.directory = dir;
        dirPathEl.textContent = this.shortenPath(dir);
        dirPathEl.title = dir;
        this.sidebar.loadRecentSessions(dir);
        this.fileExplorer.setDirectory(dir);
      }
    });

    btnStart.addEventListener('click', () => {
      this.launchTerminalInTab(tabId, 'claude');
    });

    btnContinue.addEventListener('click', () => {
      this.launchTerminalInTab(tabId, 'claude --continue');
    });

    btnBrowse.addEventListener('click', () => {
      this.launchTerminalInTab(tabId, 'claude --resume');
    });

    return launcher;
  }

  launchTerminalInTab(tabId, command) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state === 'terminal') return;

    const directory = tab.directory || this.defaultDirectory;

    // Remove launcher from wrapper
    if (tab.launcherEl && tab.launcherEl.parentNode) {
      tab.launcherEl.remove();
    }

    // Create terminal container inside the wrapper
    const termOuter = document.createElement('div');
    termOuter.className = 'tab-terminal-wrapper';
    tab.container.appendChild(termOuter);

    const termInner = document.createElement('div');
    termInner.className = 'tab-terminal-inner';
    termOuter.appendChild(termInner);

    const terminal = new TerminalSession(
      tabId,
      directory,
      termInner,
      (status, elapsed) => {
        this.updateTabStatus(tabId, status);
      },
      this.isDark
    );

    tab.state = 'terminal';
    tab.terminal = terminal;
    tab.directory = directory;
    tab.launcherEl = null;

    // Update tab name to directory
    const dirName = directory.split('/').pop() || directory;
    this.updateTabName(tabId, dirName);

    terminal.start(command);

    // Refresh sidebar and file explorer for this directory
    this.sidebar.loadRecentSessions(directory);
    this.fileExplorer.setDirectory(directory);
  }

  addTabElement(id, label) {
    const tabsEl = document.getElementById('tabs');

    // Deactivate existing tabs visually
    tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));

    const tab = document.createElement('div');
    tab.className = 'tab active';
    tab.dataset.id = id;
    tab.innerHTML = `
      <div class="tab-status"></div>
      <span class="tab-name">${label}</span>
      <button class="tab-close" title="Close tab">&times;</button>
    `;

    tab.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) {
        this.switchToTab(id);
      }
    });

    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(id);
    });

    tabsEl.appendChild(tab);
  }

  switchToTab(id) {
    // Hide current tab content
    if (this.activeTabId && this.activeTabId !== id) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab && prevTab.container) {
        prevTab.container.style.display = 'none';
      }
    }

    this.activeTabId = id;

    // Show new tab content
    const tab = this.tabs.get(id);
    if (tab && tab.container) {
      tab.container.style.display = 'block';
    }

    // Update tab bar styling
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.id === id);
    });

    // Focus terminal if in terminal state
    if (tab && tab.state === 'terminal' && tab.terminal) {
      tab.terminal.focus();
    }

    // Update sidebar and file explorer for this tab's directory
    if (tab) {
      this.sidebar.loadRecentSessions(tab.directory);
      this.fileExplorer.setDirectory(tab.directory);
    }
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Check if tab has an active terminal session
    const isActive = tab.state === 'terminal' && tab.terminal && tab.terminal.status !== 'exited';

    if (isActive) {
      this.showCloseConfirmation(id);
    } else {
      this.destroyTab(id);
    }
  }

  showCloseConfirmation(tabId) {
    // Remove any existing modal
    const existing = document.getElementById('close-tab-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'close-tab-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">Close this session?</div>
        <div class="modal-message">Claude Code is still running in this tab.</div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel">Cancel</button>
          <button class="modal-btn modal-btn-confirm">Close Tab</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const btnCancel = modal.querySelector('.modal-btn-cancel');
    const btnConfirm = modal.querySelector('.modal-btn-confirm');

    const dismiss = () => {
      modal.remove();
    };

    btnCancel.addEventListener('click', dismiss);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) dismiss();
    });

    btnConfirm.addEventListener('click', () => {
      dismiss();
      this.destroyTab(tabId);
    });

    // Focus cancel button for keyboard accessibility
    btnCancel.focus();
  }

  destroyTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Destroy terminal if active (try-catch: WebGL cleanup can throw)
    if (tab.terminal) {
      try { tab.terminal.destroy(); } catch (e) {}
    }

    // Remove DOM
    if (tab.container) {
      tab.container.remove();
    }

    // Remove tab bar element
    const tabEl = document.querySelector(`.tab[data-id="${id}"]`);
    if (tabEl) tabEl.remove();

    this.tabs.delete(id);

    // Switch to another tab or create a new launcher tab
    if (this.tabs.size > 0) {
      const nextId = this.tabs.keys().next().value;
      this.switchToTab(nextId);
    } else {
      this.activeTabId = null;
      this.createLauncherTab();
    }
  }

  updateTabStatus(id, status) {
    const tabEl = document.querySelector(`.tab[data-id="${id}"]`);
    if (!tabEl) return;

    const statusDot = tabEl.querySelector('.tab-status');
    statusDot.className = 'tab-status';
    if (status === 'waiting') {
      statusDot.classList.add('waiting');
    } else if (status !== 'exited') {
      statusDot.classList.add('working');
    }
  }

  updateTabName(id, name) {
    const tabEl = document.querySelector(`.tab[data-id="${id}"]`);
    if (!tabEl) return;
    const nameEl = tabEl.querySelector('.tab-name');
    if (nameEl) nameEl.textContent = name;
  }

  // ---- Session Click ----

  handleSessionClick(sessionId) {
    const tab = this.tabs.get(this.activeTabId);
    const command = `claude --resume ${sessionId}`;

    if (tab && tab.state === 'launcher') {
      this.launchTerminalInTab(this.activeTabId, command);
    } else {
      const id = `tab-${++this.tabCounter}`;

      const wrapper = document.createElement('div');
      wrapper.id = `tab-content-${id}`;
      wrapper.style.width = '100%';
      wrapper.style.height = '100%';
      wrapper.style.display = 'none';

      document.getElementById('terminal-container').appendChild(wrapper);

      this.tabs.set(id, {
        id,
        state: 'launcher',
        directory: tab ? tab.directory : this.defaultDirectory,
        terminal: null,
        container: wrapper,
        launcherEl: null,
      });

      this.addTabElement(id, 'Resume');
      this.switchToTab(id);
      this.launchTerminalInTab(id, command);
    }
  }

  // ---- Tab Navigation ----

  switchToAdjacentTab(direction) {
    const tabEls = document.querySelectorAll('#tabs .tab');
    if (tabEls.length <= 1) return;

    const tabIds = Array.from(tabEls).map((el) => el.dataset.id);
    const currentIndex = tabIds.indexOf(this.activeTabId);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + tabIds.length) % tabIds.length;
    this.switchToTab(tabIds[nextIndex]);
  }

  // ---- File Picker ----

  async insertFilePath() {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.state !== 'terminal' || !tab.terminal) return;

    const paths = await window.attune.selectFile();
    if (!paths || paths.length === 0) return;

    // Quote paths that contain spaces, join multiple with space
    const formatted = paths
      .map((p) => (p.includes(' ') ? `"${p}"` : p))
      .join(' ');

    window.attune.sendInput(tab.id, formatted);
    tab.terminal.focus();
  }

  // ---- Utilities ----

  shortenPath(fullPath) {
    if (!fullPath) return '';
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
