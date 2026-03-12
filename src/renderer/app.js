import { TerminalSession, getTerminalTheme } from './terminal.js';
import { Sidebar } from './sidebar.js';
import { FileExplorer } from './file-explorer.js';

class AttuneApp {
  constructor() {
    // Each tab: { id, state: 'launcher'|'terminal', directory, terminal, container, launcherEl, customName }
    this.tabs = new Map();
    this.activeTabId = null;
    this.sidebar = null;
    this.fileExplorer = null;
    this.defaultDirectory = null;
    this.tabCounter = 0;
    this.isDark = false;
    this.savedTabNames = this.loadTabNames();
  }

  async init() {
    // Load saved theme preference
    const savedTheme = localStorage.getItem('attune-theme');
    if (savedTheme === 'dark') {
      this.isDark = true;
      document.body.setAttribute('data-theme', 'dark');
    }
    // Light is default — no data-theme attribute needed

    // Check default directory status and handle first-launch / missing-directory setup
    await this.resolveDefaultDirectory();

    // Save session state on window close and periodically as safety net
    window.addEventListener('beforeunload', () => {
      this.saveSessionState();
    });
    setInterval(() => this.saveSessionState(), 5000);

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

      // Cmd+= / Cmd+Shift+= : increase font size
      if (e.metaKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.adjustFontSize(1);
      }

      // Cmd+- : decrease font size
      if (e.metaKey && e.key === '-') {
        e.preventDefault();
        this.adjustFontSize(-1);
      }

      // Cmd+0 : reset font size to default
      if (e.metaKey && e.key === '0' && !e.shiftKey) {
        e.preventDefault();
        this.setFontSize(14);
      }
    });

    // Restore previous session or create initial launcher tab
    const restored = await this.restoreSessionState();
    if (!restored) {
      this.createLauncherTab();
    }
  }

  // ---- Font Size ----

  adjustFontSize(delta) {
    const current = parseInt(localStorage.getItem('attune-font-size')) || 14;
    this.setFontSize(Math.max(10, Math.min(28, current + delta)));
  }

  setFontSize(size) {
    localStorage.setItem('attune-font-size', size);
    for (const [, tab] of this.tabs) {
      if (tab.state === 'terminal' && tab.terminal) {
        tab.terminal.setFontSize(size);
      }
    }
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

  createLauncherTab(options = {}) {
    const id = options.id || `tab-${++this.tabCounter}`;

    // Ensure tabCounter stays ahead of any restored IDs
    const idNum = parseInt(id.replace('tab-', ''), 10);
    if (!isNaN(idNum) && idNum >= this.tabCounter) {
      this.tabCounter = idNum;
    }

    const directory = options.directory || this.defaultDirectory;

    // Create the launcher DOM inside terminal-container
    const wrapper = document.createElement('div');
    wrapper.id = `tab-content-${id}`;
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.display = 'none';

    const restoreInfo = options.wasTerminal ? { wasTerminal: true, sessionId: options.sessionId } : null;
    const launcherEl = this.buildLauncherElement(id, directory, restoreInfo);
    wrapper.appendChild(launcherEl);

    document.getElementById('terminal-container').appendChild(wrapper);

    const customName = options.customName || this.savedTabNames[id] || null;

    this.tabs.set(id, {
      id,
      state: 'launcher',
      directory,
      terminal: null,
      container: wrapper,
      launcherEl,
      customName,
    });

    this.addTabElement(id, customName || (restoreInfo ? 'Saved Session' : 'New Session'));
    this.switchToTab(id);

    // Load recent sessions and file explorer for this directory
    this.sidebar.loadRecentSessions(directory);
    this.fileExplorer.setDirectory(directory);

    this.saveSessionState();
  }

  buildLauncherElement(tabId, directory, restoreInfo = null) {
    const launcher = document.createElement('div');
    launcher.className = 'tab-launcher';

    const dir = directory || this.defaultDirectory;
    const dirDisplay = this.shortenPath(dir);
    const dirFull = dir;

    if (restoreInfo && restoreInfo.wasTerminal) {
      // Restored session — same branding, but with session context and teal resume button
      launcher.innerHTML = `
        <div class="launcher-content">
          <div class="launcher-logo">
            <div class="logo-mark">A</div>
            <h1>Attune Terminal</h1>
            <p class="launcher-subtitle">Claude Code for your team</p>
          </div>

          <div class="restored-banner">
            <div class="restored-icon">&#x21bb;</div>
            <div class="restored-label">Saved Session</div>
          </div>

          <div class="restored-preview">
            <span class="restored-preview-text">Loading session preview...</span>
          </div>

          <div class="launcher-directory">
            <label>Working Directory</label>
            <div class="directory-display">
              <span class="launcher-dir-path" title="${dirFull}">${dirDisplay}</span>
              <button class="btn-secondary launcher-btn-change">Change</button>
            </div>
          </div>

          <button class="btn-restore launcher-btn-restore">Resume This Session</button>

          <div class="restored-alt-actions">
            <button class="btn-secondary launcher-btn-start">Start New</button>
            <button class="btn-secondary launcher-btn-browse">Browse Sessions</button>
          </div>

          <div class="launcher-default-dir">
            <button class="btn-change-default-dir">Change Default Directory</button>
            <button class="btn-check-updates">Check for Updates</button>
            <span class="update-status"></span>
          </div>
        </div>
      `;

      // Show session preview using the saved session ID
      const previewEl = launcher.querySelector('.restored-preview-text');
      const btnRestore = launcher.querySelector('.launcher-btn-restore');
      const savedSessionId = restoreInfo.sessionId;

      if (savedSessionId) {
        window.attune.getSessionPreview(dir, savedSessionId).then((preview) => {
          if (preview) {
            previewEl.textContent = `"${preview}"`;
          } else {
            previewEl.textContent = '(empty session)';
          }
        });
      } else {
        previewEl.textContent = 'Session ID not available — will continue most recent';
      }

      btnRestore.addEventListener('click', () => {
        if (savedSessionId) {
          this.launchTerminalInTab(tabId, `claude --resume ${savedSessionId}`);
        } else {
          this.launchTerminalInTab(tabId, 'claude --continue');
        }
      });

      const btnStart = launcher.querySelector('.launcher-btn-start');
      btnStart.addEventListener('click', () => {
        this.launchTerminalInTab(tabId, 'claude');
      });

      const btnBrowse = launcher.querySelector('.launcher-btn-browse');
      btnBrowse.addEventListener('click', () => {
        this.launchTerminalInTab(tabId, 'claude --resume');
      });
    } else {
      // Normal new session launcher
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
              <button class="btn-resume launcher-btn-continue">Continue Last</button>
              <button class="btn-resume launcher-btn-browse">Browse Sessions</button>
            </div>
          </div>

          <div class="launcher-default-dir">
            <button class="btn-change-default-dir">Change Default Directory</button>
            <button class="btn-check-updates">Check for Updates</button>
            <span class="update-status"></span>
          </div>
        </div>
      `;

      const btnStart = launcher.querySelector('.launcher-btn-start');
      btnStart.addEventListener('click', () => {
        this.launchTerminalInTab(tabId, 'claude');
      });

      const btnContinue = launcher.querySelector('.launcher-btn-continue');
      btnContinue.addEventListener('click', () => {
        this.launchTerminalInTab(tabId, 'claude --continue');
      });

      const btnBrowse = launcher.querySelector('.launcher-btn-browse');
      btnBrowse.addEventListener('click', () => {
        this.launchTerminalInTab(tabId, 'claude --resume');
      });
    }

    // Wire up shared launcher buttons (Change directory, Change Default)
    const dirPathEl = launcher.querySelector('.launcher-dir-path');
    const btnChange = launcher.querySelector('.launcher-btn-change');
    const btnChangeDefault = launcher.querySelector('.btn-change-default-dir');

    if (btnChange) {
      btnChange.addEventListener('click', async () => {
        const dir = await window.attune.selectDirectory();
        if (dir) {
          const tab = this.tabs.get(tabId);
          if (tab) tab.directory = dir;
          dirPathEl.textContent = this.shortenPath(dir);
          dirPathEl.title = dir;
          this.sidebar.loadRecentSessions(dir);
          this.fileExplorer.setDirectory(dir);
          this.saveSessionState();
        }
      });
    }

    if (btnChangeDefault) {
      btnChangeDefault.addEventListener('click', async () => {
        await this.changeDefaultDirectory();
        const tab = this.tabs.get(tabId);
        if (tab) {
          tab.directory = this.defaultDirectory;
          dirPathEl.textContent = this.shortenPath(this.defaultDirectory);
          dirPathEl.title = this.defaultDirectory;
          this.sidebar.loadRecentSessions(this.defaultDirectory);
          this.fileExplorer.setDirectory(this.defaultDirectory);
        }
      });
    }

    const btnCheckUpdates = launcher.querySelector('.btn-check-updates');
    const updateStatusEl = launcher.querySelector('.update-status');
    if (btnCheckUpdates && updateStatusEl) {
      btnCheckUpdates.addEventListener('click', () => {
        this.checkForUpdates(updateStatusEl);
      });
    }

    return launcher;
  }

  async launchTerminalInTab(tabId, command) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state === 'terminal') return;

    const directory = tab.directory || this.defaultDirectory;

    // Snapshot existing session files BEFORE launch (to detect the new one)
    const beforeIds = await window.attune.listSessionIds(directory);

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

    // Update tab name to directory basename (unless user set a custom name)
    if (!tab.customName) {
      const dirName = directory.split('/').pop() || directory;
      this.updateTabName(tabId, dirName);
    }

    terminal.start(command);

    // Detect the new session file created by Claude Code (check after 2s delay)
    setTimeout(async () => {
      try {
        const afterIds = await window.attune.listSessionIds(directory);
        const newIds = afterIds.filter((id) => !beforeIds.includes(id));
        if (newIds.length > 0) {
          tab.sessionId = newIds[0];
          this.saveSessionState();
        }
      } catch (e) {}
    }, 2000);

    // Persist state after launching terminal
    this.saveSessionState();

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
      if (!e.target.classList.contains('tab-close') && !e.target.classList.contains('tab-rename-input')) {
        this.switchToTab(id);
      }
    });

    tab.querySelector('.tab-name').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startTabRename(id);
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

    // Persist active tab change
    this.saveSessionState();
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
    this.saveTabNames();
    this.saveSessionState();

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
        customName: null,
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

  // ---- Default Directory Setup ----

  async resolveDefaultDirectory() {
    const status = await window.attune.getDefaultDirectoryStatus();

    if (status.hasSaved && status.savedExists) {
      // Saved default exists on disk — use it
      this.defaultDirectory = status.savedPath;
      return;
    }

    if (status.hasSaved && !status.savedExists) {
      // Saved default no longer exists — fall back to home and prompt
      this.defaultDirectory = await window.attune.getDefaultDirectory();
      await this.showSetupPrompt(
        'Your saved default directory no longer exists. Please choose a new default working directory.'
      );
      return;
    }

    // No saved default
    if (status.hardcodedExists) {
      // Hardcoded Attune path found — use it as default, save it
      this.defaultDirectory = await window.attune.getDefaultDirectory();
      await window.attune.setDefaultDirectory(this.defaultDirectory);
      return;
    }

    // No saved default, no hardcoded path — first launch for non-Attune user
    this.defaultDirectory = await window.attune.getDefaultDirectory();
    await this.showSetupPrompt(
      'Welcome to Attune Terminal. Choose your default working directory to get started.'
    );
  }

  showSetupPrompt(message) {
    return new Promise((resolve) => {
      // Remove any existing setup modal
      const existing = document.getElementById('setup-modal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'setup-modal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-card setup-card">
          <div class="setup-logo">
            <div class="logo-mark">A</div>
          </div>
          <div class="modal-title">Set Default Directory</div>
          <div class="modal-message">${message}</div>
          <div class="setup-current">
            <span class="setup-current-label">Current:</span>
            <span class="setup-current-path">${this.shortenPath(this.defaultDirectory)}</span>
          </div>
          <div class="modal-actions setup-actions">
            <button class="modal-btn modal-btn-cancel">Skip</button>
            <button class="modal-btn setup-btn-choose">Choose Directory</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      const btnSkip = modal.querySelector('.modal-btn-cancel');
      const btnChoose = modal.querySelector('.setup-btn-choose');

      const dismiss = () => {
        modal.remove();
        resolve();
      };

      btnSkip.addEventListener('click', dismiss);

      btnChoose.addEventListener('click', async () => {
        const dir = await window.attune.selectDirectory();
        if (dir) {
          await window.attune.setDefaultDirectory(dir);
          this.defaultDirectory = dir;
        }
        dismiss();
      });
    });
  }

  async changeDefaultDirectory() {
    const dir = await window.attune.selectDirectory();
    if (dir) {
      await window.attune.setDefaultDirectory(dir);
      this.defaultDirectory = dir;
    }
  }

  // ---- Update Check ----

  async checkForUpdates(statusEl) {
    statusEl.textContent = 'Checking...';
    statusEl.className = 'update-status';

    try {
      const currentVersion = await window.attune.getAppVersion();
      const response = await fetch(
        'https://api.github.com/repos/ksenias-bugs/attune-terminal/releases/latest',
        { headers: { 'Accept': 'application/vnd.github.v3+json' } }
      );

      if (!response.ok) {
        statusEl.textContent = 'Could not check for updates';
        statusEl.className = 'update-status update-error';
        this.clearUpdateStatus(statusEl);
        return;
      }

      const data = await response.json();
      const latestTag = data.tag_name || '';
      const latestVersion = latestTag.replace(/^v/, '');

      if (this.isNewerVersion(latestVersion, currentVersion)) {
        statusEl.textContent = `v${latestVersion} available`;
        statusEl.className = 'update-status update-available';
        statusEl.style.cursor = 'pointer';
        statusEl.onclick = () => {
          window.attune.openExternalUrl(data.html_url);
        };
      } else {
        statusEl.textContent = 'Up to date';
        statusEl.className = 'update-status update-ok';
        this.clearUpdateStatus(statusEl);
      }
    } catch (e) {
      statusEl.textContent = 'Could not check for updates';
      statusEl.className = 'update-status update-error';
      this.clearUpdateStatus(statusEl);
    }
  }

  clearUpdateStatus(el) {
    setTimeout(() => {
      el.textContent = '';
      el.className = 'update-status';
      el.style.cursor = '';
      el.onclick = null;
    }, 4000);
  }

  isNewerVersion(latest, current) {
    if (!latest || !current) return false;
    const lParts = latest.split('.').map(Number);
    const cParts = current.split('.').map(Number);
    const len = Math.max(lParts.length, cParts.length);
    for (let i = 0; i < len; i++) {
      const l = lParts[i] || 0;
      const c = cParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
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

  // ---- Tab Name Persistence ----

  loadTabNames() {
    try {
      const stored = localStorage.getItem('attune-tab-names');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }

  saveTabNames() {
    const names = {};
    for (const [id, tab] of this.tabs) {
      if (tab.customName) {
        names[id] = tab.customName;
      }
    }
    localStorage.setItem('attune-tab-names', JSON.stringify(names));
  }

  // ---- Session State Persistence ----

  saveSessionState() {
    const tabEls = document.querySelectorAll('#tabs .tab');
    const tabOrder = Array.from(tabEls).map((el) => el.dataset.id);

    const tabsData = [];
    for (const tabId of tabOrder) {
      const tab = this.tabs.get(tabId);
      if (!tab) continue;
      tabsData.push({
        id: tab.id,
        directory: tab.directory,
        customName: tab.customName || null,
        wasTerminal: tab.state === 'terminal',
        sessionId: tab.sessionId || null,
      });
    }

    const state = {
      tabs: tabsData,
      activeTabId: this.activeTabId,
    };

    // Save via IPC to config file on disk (localStorage is unreliable in Electron)
    window.attune.saveSessionState(state);
  }

  async restoreSessionState() {
    try {
      const state = await window.attune.loadSessionState();
      if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) return false;

      // Create tabs in saved order
      for (const saved of state.tabs) {
        this.createLauncherTab({
          id: saved.id,
          directory: saved.directory || this.defaultDirectory,
          customName: saved.customName || null,
          wasTerminal: saved.wasTerminal || false,
          sessionId: saved.sessionId || null,
        });
      }

      // Restore the previously active tab
      if (state.activeTabId && this.tabs.has(state.activeTabId)) {
        this.switchToTab(state.activeTabId);
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- Tab Rename (double-click) ----

  startTabRename(tabId) {
    const tabEl = document.querySelector(`.tab[data-id="${tabId}"]`);
    if (!tabEl) return;

    const nameEl = tabEl.querySelector('.tab-name');
    if (!nameEl || nameEl.classList.contains('hidden')) return;

    const currentName = nameEl.textContent;
    nameEl.classList.add('hidden');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename-input';
    input.value = currentName;
    nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
    input.select();
    input.focus();

    const commit = () => {
      const newName = input.value.trim();
      if (input.parentNode) {
        input.remove();
      }
      nameEl.classList.remove('hidden');

      if (newName && newName !== currentName) {
        const tab = this.tabs.get(tabId);
        if (tab) {
          tab.customName = newName;
          this.saveTabNames();
          this.saveSessionState();
        }
        nameEl.textContent = newName;
      }
    };

    const cancel = () => {
      if (input.parentNode) {
        input.remove();
      }
      nameEl.classList.remove('hidden');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      e.stopPropagation();
    });

    input.addEventListener('blur', () => {
      // Small delay to allow keydown to fire first
      setTimeout(() => {
        if (input.parentNode) {
          commit();
        }
      }, 0);
    });

    // Prevent click from propagating to tab switch
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  getTabDisplayName(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return 'New Session';
    if (tab.customName) return tab.customName;
    if (tab.directory) return tab.directory.split('/').pop() || tab.directory;
    return 'New Session';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AttuneApp();
  app.init();
});
