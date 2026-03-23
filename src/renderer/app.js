import { TerminalSession, getTerminalTheme } from './terminal.js';
import { Sidebar } from './sidebar.js';
import { FileExplorer } from './file-explorer.js';

class AttuneApp {
  constructor() {
    // Each tab: { id, state: 'launcher'|'terminal', directory, terminal, container, launcherEl, customName,
    //   isSplit, splitTerminal, splitPtyId, activePane: 'left'|'right' }
    this.tabs = new Map();
    this.activeTabId = null;
    this.sidebar = null;
    this.fileExplorer = null;
    this.defaultDirectory = null;
    this.tabCounter = 0;
    this.isDark = false;
    this.savedTabNames = this.loadTabNames();
    this._saveStateTimer = null;
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

    // Save session state on window close (flush immediately) and periodically as safety net
    window.addEventListener('beforeunload', () => {
      this._flushSessionState();
    });
    setInterval(() => this.saveSessionState(), 5000);

    // Initialize sidebar
    this.sidebar = new Sidebar(
      (command) => {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.state === 'terminal') {
          const ptyId = this.getActivePtyId(tab);
          const activeTextarea = tab.splitTextarea && tab.activePane === 'right'
            ? tab.splitTextarea
            : tab.textarea;
          if (activeTextarea && ptyId) {
            activeTextarea.value = command;
            activeTextarea.dispatchEvent(new Event('input'));
            // Auto-send slash commands
            window.attune.sendInput(ptyId, command + '\r');
            activeTextarea.value = '';
            activeTextarea.style.height = 'auto';
          } else {
            const term = this.getActiveTerminal(tab);
            if (term) {
              term.sendCommand(command);
              term.focus();
            }
          }
        }
      },
      (sessionId) => {
        this.handleSessionClick(sessionId);
      }
    );

    // File explorer
    this.fileExplorer = new FileExplorer((filePath) => {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && tab.state === 'terminal') {
        // Insert file path into active textarea
        const textarea = tab.splitTextarea && document.activeElement === tab.splitTextarea
          ? tab.splitTextarea
          : tab.textarea;

        if (textarea) {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const value = textarea.value;
          textarea.value = value.substring(0, start) + filePath + value.substring(end);
          textarea.selectionStart = textarea.selectionEnd = start + filePath.length;
          textarea.focus();
          textarea.dispatchEvent(new Event('input'));
        } else {
          // Fallback: send directly to PTY
          const term = this.getActiveTerminal(tab);
          const ptyId = this.getActivePtyId(tab);
          if (term && ptyId) {
            window.attune.sendInput(ptyId, filePath);
            term.focus();
          }
        }
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
        if (tab && tab.splitTerminal) tab.splitTerminal.focus();
      }, 250);
    };

    document.getElementById('btn-file-explorer-toggle').addEventListener('click', toggleFileExplorer);

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
        if (tab && tab.splitTerminal) tab.splitTerminal.focus();
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

    // Split pane button (sidebar)
    document.getElementById('btn-split-pane').addEventListener('click', () => {
      this.splitCurrentTab();
    });

    // Search all sessions button (sidebar)
    document.getElementById('btn-search-sessions').addEventListener('click', () => {
      this.showSessionSearch();
    });

    // Project instructions button (sidebar)
    document.getElementById('btn-project-instructions').addEventListener('click', () => {
      this.showProjectInstructions();
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

      // Cmd+Shift+O : open directory switcher modal
      if (e.metaKey && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        this.showDirectorySwitcher();
        return; // Don't fall through to Cmd+O
      }

      // Cmd+O : pick a file and insert path into terminal
      if (e.metaKey && !e.shiftKey && e.key === 'o') {
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

      // Cmd+F : open search bar in active terminal
      if (e.metaKey && e.key === 'f' && !e.shiftKey) {
        e.preventDefault();
        this.showSearchBar();
      }

      // Cmd+D : split current tab
      if (e.metaKey && !e.shiftKey && e.key === 'd') {
        e.preventDefault();
        this.splitCurrentTab();
      }

      // Cmd+Shift+D : unsplit current tab
      if (e.metaKey && e.shiftKey && e.key === 'd') {
        e.preventDefault();
        if (this.activeTabId) {
          this.unsplitTab(this.activeTabId);
        }
      }

    });

    // Restore previous session or create initial launcher tab
    const restored = await this.restoreSessionState();
    if (!restored) {
      this.createLauncherTab();
    }

    // Show walkthrough on first launch or after version change
    try {
      const currentVersion = await window.attune.getAppVersion();
      const lastSeen = await window.attune.getLastSeenVersion();
      if (lastSeen !== currentVersion) {
        this.showWalkthrough(currentVersion);
      }
    } catch (e) {
      console.warn('Walkthrough check failed:', e);
    }

    // Check for updates in the background on startup
    try {
      this.checkForUpdatesOnStartup();
    } catch (e) {
      // Never block app startup on a failed update check
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
      if (tab.splitTerminal) {
        tab.splitTerminal.setFontSize(size);
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
      if (tab.splitTerminal) {
        tab.splitTerminal.setTheme(this.isDark);
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
      cleanupFns: [],
    });

    this.addTabElement(id, customName || (restoreInfo ? 'Saved Session' : 'New Session'));
    this.switchToTab(id);

    // Load recent sessions, commands, and file explorer for this directory
    this.sidebar.loadRecentSessions(directory);
    this.sidebar.loadCommands(directory);
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
            <button class="btn-secondary btn-change-default-dir">Change Default Directory</button>
          </div>

          <div class="launcher-default-dir">
            <button class="btn-whats-new">All Features</button>
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
              <button class="btn-resume btn-change-default-dir">Change Default Directory</button>
            </div>
          </div>

          <div class="launcher-default-dir">
            <button class="btn-whats-new">All Features</button>
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
          this.sidebar.loadCommands(dir);
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
          this.sidebar.loadCommands(this.defaultDirectory);
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

    const btnWhatsNew = launcher.querySelector('.btn-whats-new');
    if (btnWhatsNew) {
      btnWhatsNew.addEventListener('click', async () => {
        const currentVersion = await window.attune.getAppVersion();
        this.showWalkthrough(currentVersion);
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

    const tokenBar = document.createElement('div');
    tokenBar.className = 'token-bar';
    tokenBar.id = `token-bar-${tabId}`;
    tokenBar.innerHTML = '<span class="token-count"></span><span class="token-cost"></span>';
    termOuter.appendChild(tokenBar);

    // Create input area
    const inputArea = document.createElement('div');
    inputArea.className = 'tab-input-area';

    const textarea = document.createElement('textarea');
    textarea.className = 'tab-input-textarea';
    textarea.placeholder = 'Message Claude...';
    textarea.rows = 1;
    textarea.spellcheck = false;

    // Send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'tab-input-send';
    sendBtn.title = 'Send (Enter)';
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8L14 8M14 8L9 3M14 8L9 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    inputArea.appendChild(textarea);
    inputArea.appendChild(sendBtn);
    termOuter.appendChild(inputArea);

    // Store textarea reference on tab
    tab.textarea = textarea;
    tab.inputArea = inputArea;

    // Auto-resize textarea
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      const maxHeight = parseInt(getComputedStyle(textarea).lineHeight) * 6;
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    const sendMessage = () => {
      const text = textarea.value;
      if (!text.trim()) return;
      window.attune.sendInput(tabId, text + '\r');
      textarea.value = '';
      textarea.style.height = 'auto';
      textarea.focus();
    };

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      // Escape moves focus to terminal
      if (e.key === 'Escape') {
        e.preventDefault();
        // tab.terminal may not be set yet during init, use variable if available
        if (tab.terminal) tab.terminal.focus();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    const terminal = new TerminalSession(
      tabId,
      directory,
      termInner,
      (status, elapsed) => {
        this.updateTabStatus(tabId, status);
        if (status === 'waiting' && tab.textarea) {
          tab.textarea.focus();
        }
      },
      this.isDark
    );

    // Drag-and-drop file support
    termOuter.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!tab.isSplit) {
        termOuter.classList.add('drop-active');
      }
    });

    termOuter.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      termOuter.classList.remove('drop-active');
    });

    termOuter.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      termOuter.classList.remove('drop-active');

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // In split mode, use coordinates to target the correct pane
      let ptyId = tabId;
      let term = terminal;
      if (tab.isSplit) {
        const leftPane = termOuter.querySelector('.split-pane-left');
        if (leftPane) {
          const leftRect = leftPane.getBoundingClientRect();
          if (e.clientX >= leftRect.right) {
            ptyId = tab.splitPtyId;
            term = tab.splitTerminal;
          }
        }
      }

      const paths = [];
      for (let i = 0; i < files.length; i++) {
        const filePath = window.attune.getPathForFile(files[i]);
        if (filePath) {
          paths.push(filePath.includes(' ') ? `"${filePath}"` : filePath);
        }
      }

      if (paths.length > 0) {
        const joinedPaths = paths.join(' ');
        // Determine the right textarea based on which pane was targeted
        const targetTextarea = (tab.isSplit && ptyId === tab.splitPtyId)
          ? tab.splitTextarea
          : tab.textarea;

        if (targetTextarea) {
          const start = targetTextarea.selectionStart;
          const end = targetTextarea.selectionEnd;
          const value = targetTextarea.value;
          targetTextarea.value = value.substring(0, start) + joinedPaths + value.substring(end);
          targetTextarea.selectionStart = targetTextarea.selectionEnd = start + joinedPaths.length;
          targetTextarea.focus();
          targetTextarea.dispatchEvent(new Event('input'));
        } else if (ptyId && term) {
          window.attune.sendInput(ptyId, joinedPaths);
          term.focus();
        }
      }
    });

    tab.state = 'terminal';
    tab.terminal = terminal;
    tab.directory = directory;
    tab.launcherEl = null;

    // Update tab name to directory basename (unless user set a custom name)
    if (!tab.customName) {
      const dirName = directory.split('/').pop() || directory;
      this.updateTabName(tabId, dirName);
    }

    await terminal.start(command);

    // Poll token/cost data from the terminal session and update the token bar
    const tokenInterval = setInterval(() => {
      const bar = document.getElementById(`token-bar-${tabId}`);
      if (bar && terminal.estimatedCost) {
        const countEl = bar.querySelector('.token-count');
        const costEl = bar.querySelector('.token-cost');
        if (terminal.contextPercent) {
          countEl.textContent = `ctx: ${terminal.contextPercent}%`;
        }
        if (terminal.estimatedCost) {
          costEl.textContent = ` · ${terminal.estimatedCost}`;
        }
        bar.classList.add('visible');
      }
    }, 2000);
    tab.cleanupFns.push(() => clearInterval(tokenInterval));

    // Detect session ID with retry
    const detectSessionId = async (attempt = 0) => {
      if (attempt >= 5) return; // Give up after 5 attempts (10 seconds)
      try {
        const afterIds = await window.attune.listSessionIds(directory);
        const newIds = afterIds.filter((id) => !beforeIds.includes(id));
        if (newIds.length > 0) {
          tab.sessionId = newIds[0];
          this.saveSessionState();
        } else {
          setTimeout(() => detectSessionId(attempt + 1), 2000);
        }
      } catch (e) {
        console.error('Session ID detection failed:', e);
        setTimeout(() => detectSessionId(attempt + 1), 2000);
      }
    };
    setTimeout(() => detectSessionId(), 2000);

    // Save this directory to recent directories list
    window.attune.saveRecentDirectory(directory);

    // Persist state after launching terminal
    this.saveSessionState();

    // Refresh sidebar, file explorer, and CLAUDE.md preview for this directory
    this.sidebar.loadRecentSessions(directory);
    this.sidebar.loadCommands(directory);
    this.fileExplorer.setDirectory(directory);

    // Show restart bar when the PTY exits
    const cleanupMainExit = window.attune.onPtyExit(tabId, () => {
      // Show restart option
      const restartBar = document.createElement('div');
      restartBar.className = 'restart-bar';
      restartBar.innerHTML = '<span>Session ended</span><button class="restart-btn">Restart Claude</button>';
      const termWrapper = termOuter.querySelector('.tab-terminal-wrapper') || termOuter;
      termWrapper.appendChild(restartBar);

      restartBar.querySelector('.restart-btn').addEventListener('click', () => {
        restartBar.remove();
        terminal.terminal.clear();
        terminal.destroy();
        const newTerminal = new TerminalSession(
          tabId,
          directory,
          termInner,
          (status, elapsed) => {
            this.updateTabStatus(tabId, status);
          },
          this.isDark
        );
        tab.terminal = newTerminal;
        newTerminal.start('claude').catch(e => console.error('Terminal start failed:', e));
        newTerminal.focus();
      });
    });
    tab.cleanupFns.push(cleanupMainExit);

    // Show restart bar when Claude exits (but shell stays alive)
    terminal.onSessionExit = () => {
      const existingBar = termOuter.querySelector('.restart-bar');
      if (existingBar) return; // Already showing

      const restartBar = document.createElement('div');
      restartBar.className = 'restart-bar';
      restartBar.innerHTML = '<span>Session ended</span><button class="restart-btn">Restart Claude</button>';
      const termWrapper = termOuter.querySelector('.tab-terminal-wrapper') || termOuter;
      termWrapper.appendChild(restartBar);

      restartBar.querySelector('.restart-btn').addEventListener('click', () => {
        restartBar.remove();
        terminal.status = 'launching';  // Reset so exit detection works again
        // Send 'claude\r' to the existing shell to restart
        window.attune.sendInput(tabId, 'claude\r');
      });
    };
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
    if (tab && tab.state === 'terminal') {
      const term = this.getActiveTerminal(tab);
      if (term) term.focus();
    }

    // Update sidebar and file explorer for this tab's directory
    if (tab) {
      this.sidebar.loadRecentSessions(tab.directory);
      this.sidebar.loadCommands(tab.directory);
      this.fileExplorer.setDirectory(tab.directory);
    }

    // Persist active tab change
    this.saveSessionState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Check if tab has an active terminal session (either pane)
    const leftActive = tab.state === 'terminal' && tab.terminal && tab.terminal.status !== 'exited';
    const rightActive = tab.isSplit && tab.splitTerminal && tab.splitTerminal.status !== 'exited';

    if (leftActive || rightActive) {
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

    // Run tab-level cleanup functions (token polling, etc.)
    if (tab.cleanupFns) {
      for (const fn of tab.cleanupFns) {
        try { fn(); } catch (e) {}
      }
      tab.cleanupFns = [];
    }

    // Destroy terminal if active (try-catch: WebGL cleanup can throw)
    if (tab.terminal) {
      try { tab.terminal.destroy(); } catch (e) {}
    }

    // Destroy split terminal if present
    if (tab.splitTerminal) {
      try { tab.splitTerminal.destroy(); } catch (e) {}
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
    // For split tabs, the id might be the splitPtyId — resolve back to the tab
    let tabId = id;
    let tab = this.tabs.get(id);
    if (!tab) {
      // Check if this id is a splitPtyId
      for (const [tid, t] of this.tabs) {
        if (t.splitPtyId === id) {
          tabId = tid;
          tab = t;
          break;
        }
      }
    }

    const tabEl = document.querySelector(`.tab[data-id="${tabId}"]`);
    if (!tabEl) return;

    // For split tabs, compute the combined status: most urgent wins
    // Priority: approval > working > waiting > exited
    if (tab && tab.isSplit) {
      const leftStatus = tab.terminal ? tab.terminal.status : 'exited';
      const rightStatus = tab.splitTerminal ? tab.splitTerminal.status : 'exited';
      const statusPriority = { approval: 4, thinking: 3, tools: 3, agents: 3, working: 3, launching: 2, waiting: 1, exited: 0 };
      const effectiveStatus = (statusPriority[leftStatus] || 0) >= (statusPriority[rightStatus] || 0) ? leftStatus : rightStatus;
      const statusDot = tabEl.querySelector('.tab-status');
      statusDot.className = 'tab-status';
      if (effectiveStatus === 'waiting') {
        statusDot.classList.add('waiting');
      } else if (effectiveStatus !== 'exited') {
        statusDot.classList.add('working');
      }
    } else {
      const statusDot = tabEl.querySelector('.tab-status');
      statusDot.className = 'tab-status';
      if (status === 'waiting') {
        statusDot.classList.add('waiting');
      } else if (status !== 'exited') {
        statusDot.classList.add('working');
      }
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
        cleanupFns: [],
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
    if (!tab || tab.state !== 'terminal') return;

    const paths = await window.attune.selectFile();
    if (!paths || paths.length === 0) return;

    // Quote paths that contain spaces, join multiple with space
    const formatted = paths
      .map((p) => (p.includes(' ') ? `"${p}"` : p))
      .join(' ');

    // Determine which textarea is active (main or split)
    const textarea = tab.splitTextarea && document.activeElement === tab.splitTextarea
      ? tab.splitTextarea
      : tab.textarea;

    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      textarea.value = value.substring(0, start) + formatted + value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + formatted.length;
      textarea.focus();
      // Trigger resize
      textarea.dispatchEvent(new Event('input'));
    } else {
      // Fallback: send directly to PTY if no textarea available
      const term = this.getActiveTerminal(tab);
      const ptyId = this.getActivePtyId(tab);
      if (term && ptyId) {
        window.attune.sendInput(ptyId, formatted);
        term.focus();
      }
    }
  }

  // ---- Directory Switcher ----

  async showDirectorySwitcher() {
    const existing = document.getElementById('dir-switcher-modal');
    if (existing) existing.remove();
    const recentDirs = await window.attune.getRecentDirectories();
    const modal = document.createElement('div');
    modal.id = 'dir-switcher-modal';
    modal.className = 'modal-overlay';
    let recentListHTML = '';
    if (recentDirs.length > 0) {
      const items = recentDirs.map((dir) => {
        const display = this.shortenPath(dir);
        const escaped = dir.replace(/"/g, '&quot;');
        return `<div class="dir-switcher-item" data-dir="${escaped}" title="${escaped}"><span class="dir-switcher-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.3h4.5c.83 0 1.5.67 1.5 1.5v6.7c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="dir-switcher-item-path">${display}</span></div>`;
      }).join('');
      recentListHTML = `<div class="dir-switcher-recent-header">Recent Directories</div><div class="dir-switcher-recent-list">${items}</div>`;
    } else {
      recentListHTML = '<div class="dir-switcher-empty">No recent directories yet</div>';
    }
    modal.innerHTML = `<div class="modal-card dir-switcher-card"><div class="dir-switcher-header"><span class="dir-switcher-title">Open Directory</span><button class="dir-switcher-close">&times;</button></div><div class="dir-switcher-browse"><button class="dir-switcher-browse-btn"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.3h4.5c.83 0 1.5.67 1.5 1.5v6.7c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Browse...</button></div><div class="dir-switcher-recent">${recentListHTML}</div><div class="dir-switcher-shortcut"><kbd>Esc</kbd> to close</div></div>`;
    document.body.appendChild(modal);
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
    };
    const dismiss = () => {
      modal.remove();
      document.removeEventListener('keydown', keyHandler, true);
    };
    const openDirectory = (dir) => {
      dismiss();
      // If current tab is a launcher, update its directory; otherwise open new tab
      const currentTab = this.tabs.get(this.activeTabId);
      if (currentTab && currentTab.state === 'launcher') {
        currentTab.directory = dir;
        const dirPathEl = currentTab.launcherEl?.querySelector('.launcher-dir-path');
        if (dirPathEl) {
          dirPathEl.textContent = this.shortenPath(dir);
          dirPathEl.title = dir;
        }
        this.sidebar.loadRecentSessions(dir);
        this.sidebar.loadCommands(dir);
        this.fileExplorer.setDirectory(dir);
        this.saveSessionState();
      } else {
        this.createLauncherTab({ directory: dir });
      }
    };
    modal.querySelector('.dir-switcher-browse-btn').addEventListener('click', async () => {
      const dir = await window.attune.selectDirectory();
      if (dir) openDirectory(dir);
    });
    modal.querySelector('.dir-switcher-close').addEventListener('click', dismiss);
    modal.addEventListener('click', (e) => { if (e.target === modal) dismiss(); });
    modal.querySelectorAll('.dir-switcher-item').forEach((item) => {
      item.addEventListener('click', () => {
        const dir = item.dataset.dir;
        if (dir) openDirectory(dir);
      });
    });
    document.addEventListener('keydown', keyHandler, true);
    modal.querySelector('.dir-switcher-browse-btn').focus();
  }

  // ---- Session Search (cross-directory) ----

  async showSessionSearch() {
    const existing = document.getElementById('session-search-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'session-search-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card session-search-card">
        <div class="session-search-header">
          <span class="session-search-title">Search All Sessions</span>
          <button class="session-search-close">&times;</button>
        </div>
        <div class="session-search-input-wrap">
          <input type="text" class="session-search-input" placeholder="Search by message or directory..." spellcheck="false" autocomplete="off" />
        </div>
        <div class="session-search-results">
          <div class="session-search-loading">Loading recent sessions...</div>
        </div>
        <div class="session-search-footer"><kbd>Esc</kbd> to close</div>
      </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('.session-search-input');
    const resultsContainer = modal.querySelector('.session-search-results');

    // Format relative time
    const formatRelativeTime = (isoTimestamp) => {
      const now = Date.now();
      const then = new Date(isoTimestamp).getTime();
      const diffMs = now - then;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return `${diffDay}d ago`;
      return new Date(isoTimestamp).toLocaleDateString();
    };

    // Render results
    const renderResults = (sessions) => {
      if (!sessions || sessions.length === 0) {
        resultsContainer.innerHTML = '<div class="session-search-empty">No sessions found</div>';
        return;
      }

      resultsContainer.innerHTML = sessions.map((s) => {
        const dirBasename = s.directory.split('/').pop() || s.directory;
        const dirDisplay = this.shortenPath(s.directory);
        const escapedDir = s.directory.replace(/"/g, '&quot;');
        const escapedId = s.sessionId.replace(/"/g, '&quot;');
        const summary = s.summary.length > 100 ? s.summary.slice(0, 100) + '...' : s.summary;
        const time = formatRelativeTime(s.timestamp);
        return `
          <div class="session-search-item" data-dir="${escapedDir}" data-session-id="${escapedId}">
            <div class="session-search-item-top">
              <span class="session-search-item-dir" title="${escapedDir}">${this.escapeHtml(dirDisplay)}</span>
              <span class="session-search-item-time">${time}</span>
            </div>
            <div class="session-search-item-summary">${this.escapeHtml(summary)}</div>
          </div>
        `;
      }).join('');

      // Wire up click handlers
      resultsContainer.querySelectorAll('.session-search-item').forEach((item) => {
        item.addEventListener('click', () => {
          const dir = item.dataset.dir;
          const sessionId = item.dataset.sessionId;
          dismiss();
          this.openSessionInNewTab(dir, sessionId);
        });
      });
    };

    // Debounce timer
    let debounceTimer = null;

    const doSearch = async (query) => {
      try {
        const results = await window.attune.searchAllSessions(query);
        renderResults(results);
      } catch (e) {
        resultsContainer.innerHTML = '<div class="session-search-empty">Error searching sessions</div>';
      }
    };

    // Keyboard and dismiss handlers
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }
    };

    const dismiss = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      modal.remove();
      document.removeEventListener('keydown', keyHandler, true);
    };

    modal.querySelector('.session-search-close').addEventListener('click', dismiss);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) dismiss();
    });

    input.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        doSearch(input.value);
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('keydown', keyHandler, true);

    // Focus input and load initial (recent) results
    input.focus();
    doSearch('');
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  openSessionInNewTab(directory, sessionId) {
    const command = `claude --resume ${sessionId}`;
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
      directory: directory,
      terminal: null,
      container: wrapper,
      launcherEl: null,
      customName: null,
      cleanupFns: [],
    });

    const dirName = directory.split('/').pop() || directory;
    this.addTabElement(id, dirName);
    this.switchToTab(id);
    this.launchTerminalInTab(id, command);
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

    // No saved default — first launch, prompt user to pick a directory
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

  showWalkthrough(version) {
    // Remove any existing walkthrough overlay
    const existing = document.querySelector('.walkthrough-overlay');
    if (existing) existing.remove();

    const features = [
      { name: 'Tabs', desc: 'Run multiple sessions at once. Use the + button in the tab bar, or \u2318T.' },
      { name: 'Split Pane', desc: 'Two terminals in one tab. Use the Split Pane button in the sidebar, or \u2318D.' },
      { name: 'Find in Output', desc: 'Search through terminal output with \u2318F.' },
      { name: 'Drag & Drop', desc: 'Drag a file from Finder into the terminal to paste its path.' },
      { name: 'Open Directory', desc: 'Quickly switch your working folder with \u21e7\u2318O. Shows your recent directories.' },
      { name: 'Attach File', desc: 'Insert a file path into your message from the sidebar button or \u2318O.' },
      { name: 'Project Instructions', desc: 'View your CLAUDE.md file via the sidebar button \u2014 opens in a popup.' },
      { name: 'Search All Sessions', desc: 'Find past conversations across every project from the sidebar.' },
      { name: 'Token Tracker', desc: 'Token usage and cost appear at the bottom of the terminal as you work.' },
      { name: 'Resume Sessions', desc: 'Pick up old conversations from the launcher \u2014 your sessions are saved.' },
      { name: 'Light & Dark Mode', desc: 'Toggle with the sun/moon icon in the top-right corner.' },
      { name: 'Shortcuts', desc: 'Full cheat sheet of keyboard shortcuts in the sidebar.' },
    ];

    const featuresHtml = features
      .map(
        (f) =>
          `<div class="walkthrough-feature">
            <span class="walkthrough-feature-name">${f.name}</span>
            <span class="walkthrough-feature-desc">${f.desc}</span>
          </div>`
      )
      .join('');

    const overlay = document.createElement('div');
    overlay.className = 'walkthrough-overlay';
    overlay.innerHTML = `
      <div class="walkthrough-card">
        <div class="walkthrough-title">Welcome to Attune Terminal <span style="font-weight:400;color:var(--text-muted);">v${version}</span></div>
        <div class="walkthrough-subtitle">Claude Code for your team</div>
        <div class="walkthrough-features">${featuresHtml}</div>
        <button class="walkthrough-btn">Got it</button>
      </div>
    `;

    const dismiss = () => {
      overlay.remove();
      window.attune.setLastSeenVersion(version);
    };

    overlay.querySelector('.walkthrough-btn').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && document.querySelector('.walkthrough-overlay')) {
        dismiss();
        document.removeEventListener('keydown', onEsc);
      }
    });

    document.body.appendChild(overlay);
  }

  // Core update check — returns { hasUpdate, latestVersion, htmlUrl } or null on failure
  async _fetchUpdateInfo() {
    const currentVersion = await window.attune.getAppVersion();
    const result = await window.attune.checkForUpdates();
    if (!result.ok) return null;

    const latestTag = result.tagName || '';
    const latestVersion = latestTag.replace(/^v/, '');

    if (this.isNewerVersion(latestVersion, currentVersion)) {
      return { hasUpdate: true, latestVersion, htmlUrl: result.htmlUrl };
    }
    return { hasUpdate: false };
  }

  // Button-triggered update check (writes to a status element in the launcher)
  async checkForUpdates(statusEl) {
    statusEl.textContent = 'Checking...';
    statusEl.className = 'update-status';

    try {
      const info = await this._fetchUpdateInfo();

      if (!info) {
        statusEl.textContent = 'Could not check for updates';
        statusEl.className = 'update-status update-error';
        this.clearUpdateStatus(statusEl);
        return;
      }

      if (info.hasUpdate) {
        statusEl.textContent = `v${info.latestVersion} available`;
        statusEl.className = 'update-status update-available';
        statusEl.style.cursor = 'pointer';
        statusEl.onclick = () => {
          window.attune.openExternalUrl(info.htmlUrl);
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

  // Startup update check — shows a non-intrusive banner at the top of the terminal area
  async checkForUpdatesOnStartup() {
    try {
      const info = await this._fetchUpdateInfo();
      if (!info || !info.hasUpdate) return;

      // Don't show the banner if one is already visible
      if (document.getElementById('update-banner')) return;

      const banner = document.createElement('div');
      banner.id = 'update-banner';
      banner.className = 'update-banner';
      banner.innerHTML = `
        <span class="update-banner-text">
          A new version (v${info.latestVersion}) is available.
        </span>
        <button class="update-banner-link">Download</button>
        <button class="update-banner-dismiss" title="Dismiss">&times;</button>
      `;

      banner.querySelector('.update-banner-link').addEventListener('click', () => {
        window.attune.openExternalUrl(info.htmlUrl);
      });

      banner.querySelector('.update-banner-dismiss').addEventListener('click', () => {
        banner.remove();
      });

      const terminalArea = document.getElementById('terminal-area');
      terminalArea.insertBefore(banner, terminalArea.firstChild);
    } catch (e) {
      // Silent failure — never block the app on update check
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

  // ---- Terminal Search (Cmd+F) ----

  showSearchBar() {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.state !== 'terminal' || !tab.terminal) return;

    // Determine which pane to attach the search bar to
    const activeTerm = this.getActiveTerminal(tab);
    if (!activeTerm) return;

    // Find the container for this pane (split pane or terminal wrapper)
    let paneContainer;
    if (tab.isSplit) {
      const pane = tab.activePane === 'right' ? 'split-pane-right' : 'split-pane-left';
      paneContainer = tab.container.querySelector('.' + pane);
    } else {
      paneContainer = tab.container.querySelector('.tab-terminal-wrapper');
    }
    if (!paneContainer) return;

    // If this pane already has a search bar, just focus it
    const existing = paneContainer.querySelector('.terminal-search-bar');
    if (existing) {
      existing.querySelector('.search-input').focus();
      existing.querySelector('.search-input').select();
      return;
    }

    const searchBar = document.createElement('div');
    searchBar.className = 'terminal-search-bar';
    searchBar.innerHTML = `
      <input type="text" class="search-input" placeholder="Search..." spellcheck="false" autocomplete="off" />
      <button class="search-btn search-btn-prev" title="Previous match (Shift+Enter)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 9L2 5l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="search-btn search-btn-next" title="Next match (Enter)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="search-btn search-btn-close" title="Close (Escape)">&times;</button>
    `;

    // Insert into the specific pane (positioned absolutely within it)
    paneContainer.appendChild(searchBar);

    const input = searchBar.querySelector('.search-input');
    const btnPrev = searchBar.querySelector('.search-btn-prev');
    const btnNext = searchBar.querySelector('.search-btn-next');
    const btnClose = searchBar.querySelector('.search-btn-close');

    const doSearch = (direction) => {
      const query = input.value;
      if (!query) return;
      if (direction === 'next') {
        activeTerm.findNext(query);
      } else {
        activeTerm.findPrevious(query);
      }
    };

    const closeSearch = () => {
      activeTerm.clearSearch();
      activeTerm.focus();
      searchBar.remove();
    };

    // Search on input change (incremental search)
    input.addEventListener('input', () => {
      doSearch('next');
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          doSearch('prev');
        } else {
          doSearch('next');
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      }
      // Stop propagation so terminal doesn't receive these keystrokes
      e.stopPropagation();
    });

    btnPrev.addEventListener('click', () => doSearch('prev'));
    btnNext.addEventListener('click', () => doSearch('next'));
    btnClose.addEventListener('click', closeSearch);

    // Focus the input
    input.focus();
  }

  // ---- Split Pane ----

  getActiveTerminal(tab) {
    if (!tab) return null;
    if (tab.isSplit && tab.activePane === 'right' && tab.splitTerminal) {
      return tab.splitTerminal;
    }
    return tab.terminal;
  }

  getActivePtyId(tab) {
    if (!tab) return null;
    if (tab.isSplit && tab.activePane === 'right' && tab.splitPtyId) {
      return tab.splitPtyId;
    }
    return tab.id;
  }

  setActivePane(tabId, pane) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.isSplit) return;
    tab.activePane = pane;

    // Update visual indicator
    const wrapper = tab.container.querySelector('.tab-terminal-wrapper');
    if (!wrapper) return;
    const leftPane = wrapper.querySelector('.split-pane-left');
    const rightPane = wrapper.querySelector('.split-pane-right');
    if (leftPane) leftPane.classList.toggle('active-pane', pane === 'left');
    if (rightPane) rightPane.classList.toggle('active-pane', pane === 'right');
  }

  splitCurrentTab() {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.state !== 'terminal' || tab.isSplit) return;

    const directory = tab.directory;
    const wrapper = tab.container.querySelector('.tab-terminal-wrapper');
    if (!wrapper) return;

    // Wrap existing terminal content in a left pane
    const leftPane = document.createElement('div');
    leftPane.className = 'split-pane split-pane-left active-pane';

    // Move the existing tab-terminal-inner into the left pane
    const existingInner = wrapper.querySelector('.tab-terminal-inner');
    if (existingInner) {
      leftPane.appendChild(existingInner);
    }

    // Create input area for left pane
    const leftInputArea = document.createElement('div');
    leftInputArea.className = 'tab-input-area';

    const leftTextarea = document.createElement('textarea');
    leftTextarea.className = 'tab-input-textarea';
    leftTextarea.placeholder = 'Message Claude...';
    leftTextarea.rows = 1;
    leftTextarea.spellcheck = false;

    const leftSendBtn = document.createElement('button');
    leftSendBtn.className = 'tab-input-send';
    leftSendBtn.title = 'Send (Enter)';
    leftSendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8L14 8M14 8L9 3M14 8L9 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    leftInputArea.appendChild(leftTextarea);
    leftInputArea.appendChild(leftSendBtn);
    leftPane.appendChild(leftInputArea);

    // Reassign tab.textarea to left pane's textarea
    tab.textarea = leftTextarea;
    tab.inputArea = leftInputArea;

    // Auto-resize left textarea
    leftTextarea.addEventListener('input', () => {
      leftTextarea.style.height = 'auto';
      const maxHeight = parseInt(getComputedStyle(leftTextarea).lineHeight) * 6;
      leftTextarea.style.height = Math.min(leftTextarea.scrollHeight, maxHeight) + 'px';
    });

    const sendLeftMessage = () => {
      const text = leftTextarea.value;
      if (!text.trim()) return;
      window.attune.sendInput(tab.id, text + '\r');
      leftTextarea.value = '';
      leftTextarea.style.height = 'auto';
      leftTextarea.focus();
    };

    leftTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendLeftMessage();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (tab.terminal) tab.terminal.focus();
      }
    });

    leftSendBtn.addEventListener('click', sendLeftMessage);

    // Create divider with drag-to-resize
    const divider = document.createElement('div');
    divider.className = 'split-divider';

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const wrapperRect = wrapper.getBoundingClientRect();
      const startLeftWidth = leftPane.getBoundingClientRect().width;

      const onMouseMove = (ev) => {
        const delta = ev.clientX - startX;
        const newLeftWidth = startLeftWidth + delta;
        const totalWidth = wrapperRect.width - 5; // minus divider width
        const pct = Math.max(20, Math.min(80, (newLeftWidth / totalWidth) * 100));
        leftPane.style.flex = 'none';
        leftPane.style.width = pct + '%';
        rightPane.style.flex = 'none';
        rightPane.style.width = (100 - pct) + '%';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Refit both terminals to new dimensions
        if (tab.terminal) tab.terminal._safeFit();
        if (tab.splitTerminal) tab.splitTerminal._safeFit();
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Create right pane
    const rightPane = document.createElement('div');
    rightPane.className = 'split-pane split-pane-right';

    const rightInner = document.createElement('div');
    rightInner.className = 'tab-terminal-inner';
    rightPane.appendChild(rightInner);

    // Add close button on the right pane
    const closeBtn = document.createElement('button');
    closeBtn.className = 'split-pane-close';
    closeBtn.title = 'Close split pane';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.unsplitTab(this.activeTabId);
    });
    rightPane.appendChild(closeBtn);

    // Create input area for right (split) pane
    const splitInputArea = document.createElement('div');
    splitInputArea.className = 'tab-input-area';

    const splitTextarea = document.createElement('textarea');
    splitTextarea.className = 'tab-input-textarea';
    splitTextarea.placeholder = 'Message Claude...';
    splitTextarea.rows = 1;
    splitTextarea.spellcheck = false;

    const splitSendBtn = document.createElement('button');
    splitSendBtn.className = 'tab-input-send';
    splitSendBtn.title = 'Send (Enter)';
    splitSendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8L14 8M14 8L9 3M14 8L9 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    splitInputArea.appendChild(splitTextarea);
    splitInputArea.appendChild(splitSendBtn);
    rightPane.appendChild(splitInputArea);

    // Clear wrapper and rebuild with split layout
    wrapper.innerHTML = '';
    wrapper.classList.add('split');
    wrapper.appendChild(leftPane);
    wrapper.appendChild(divider);
    wrapper.appendChild(rightPane);

    // Generate a unique PTY ID for the split terminal
    const splitPtyId = `${tab.id}-split`;

    // Create new terminal session for the right pane
    const splitTerminal = new TerminalSession(
      splitPtyId,
      directory,
      rightInner,
      (status, elapsed) => {
        this.updateTabStatus(splitPtyId, status);
        if (status === 'waiting' && tab.splitTextarea) {
          tab.splitTextarea.focus();
        }
      },
      this.isDark
    );

    // Set split state on the tab
    tab.isSplit = true;
    tab.splitTerminal = splitTerminal;
    tab.splitPtyId = splitPtyId;
    tab.activePane = 'left';

    // Store split textarea references
    tab.splitTextarea = splitTextarea;
    tab.splitInputArea = splitInputArea;

    // Auto-resize split textarea
    splitTextarea.addEventListener('input', () => {
      splitTextarea.style.height = 'auto';
      const maxHeight = parseInt(getComputedStyle(splitTextarea).lineHeight) * 6;
      splitTextarea.style.height = Math.min(splitTextarea.scrollHeight, maxHeight) + 'px';
    });

    const sendSplitMessage = () => {
      const text = splitTextarea.value;
      if (!text.trim()) return;
      window.attune.sendInput(tab.splitPtyId, text + '\r');
      splitTextarea.value = '';
      splitTextarea.style.height = 'auto';
      splitTextarea.focus();
    };

    splitTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendSplitMessage();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (tab.splitTerminal) tab.splitTerminal.focus();
      }
    });

    splitSendBtn.addEventListener('click', sendSplitMessage);

    // Focus management: clicking a pane makes it active
    leftPane.addEventListener('mousedown', () => {
      this.setActivePane(tab.id, 'left');
    });
    rightPane.addEventListener('mousedown', () => {
      this.setActivePane(tab.id, 'right');
    });

    // Start the right pane terminal with claude
    splitTerminal.start('claude').catch(e => console.error('Split terminal start failed:', e));

    // When the split terminal exits, show a message but keep the left pane active
    const cleanupSplitExit = window.attune.onPtyExit(splitPtyId, () => {
      if (tab.isSplit && tab.splitTerminal) {
        // The terminal's own exit handler already writes the exit message.
        // Just switch focus to the left pane.
        this.setActivePane(tab.id, 'left');
        if (tab.terminal) tab.terminal.focus();
      }
    });
    if (!tab._splitCleanupFns) tab._splitCleanupFns = [];
    tab._splitCleanupFns.push(cleanupSplitExit);

    // Refit both terminals after layout change — need delay for flex to settle
    // Do two passes: one quick for visual, one after animation completes
    const refitBoth = () => {
      if (tab.terminal) {
        tab.terminal._safeFit();
        tab.terminal.focus();
      }
      if (splitTerminal) {
        splitTerminal._safeFit();
      }
    };
    setTimeout(refitBoth, 150);
    setTimeout(refitBoth, 500);

    this.saveSessionState();
  }

  unsplitTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.isSplit) return;

    // Destroy the split terminal
    if (tab.splitTerminal) {
      try { tab.splitTerminal.destroy(); } catch (e) {}
    }

    // Clean up split-specific listeners
    if (tab._splitCleanupFns) {
      for (const fn of tab._splitCleanupFns) fn();
      tab._splitCleanupFns = [];
    }

    const wrapper = tab.container.querySelector('.tab-terminal-wrapper');
    if (!wrapper) return;

    // Get the left pane's terminal inner
    const leftPane = wrapper.querySelector('.split-pane-left');
    const leftInner = leftPane ? leftPane.querySelector('.tab-terminal-inner') : null;

    // Rebuild wrapper as single pane
    wrapper.innerHTML = '';
    wrapper.classList.remove('split');
    if (leftInner) {
      wrapper.appendChild(leftInner);
    }

    // Recreate input area for single pane
    const inputArea = document.createElement('div');
    inputArea.className = 'tab-input-area';

    const textarea = document.createElement('textarea');
    textarea.className = 'tab-input-textarea';
    textarea.placeholder = 'Message Claude...';
    textarea.rows = 1;
    textarea.spellcheck = false;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'tab-input-send';
    sendBtn.title = 'Send (Enter)';
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8L14 8M14 8L9 3M14 8L9 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    inputArea.appendChild(textarea);
    inputArea.appendChild(sendBtn);
    wrapper.appendChild(inputArea);

    tab.textarea = textarea;
    tab.inputArea = inputArea;

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      const maxHeight = parseInt(getComputedStyle(textarea).lineHeight) * 6;
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    });

    const sendMessage = () => {
      const text = textarea.value;
      if (!text.trim()) return;
      window.attune.sendInput(tab.id, text + '\r');
      textarea.value = '';
      textarea.style.height = 'auto';
      textarea.focus();
    };

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (tab.terminal) tab.terminal.focus();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    // Clear split state
    tab.isSplit = false;
    tab.splitTerminal = null;
    tab.splitPtyId = null;
    tab.splitTextarea = null;
    tab.splitInputArea = null;
    tab.activePane = null;

    // Refit and focus the remaining terminal — delay for flex to settle
    setTimeout(() => {
      if (tab.terminal) {
        tab.terminal._safeFit();
        tab.terminal.focus();
      }
    }, 100);

    this.saveSessionState();
  }

  // ---- Project Instructions Modal ----

  async showProjectInstructions() {
    const tab = this.tabs.get(this.activeTabId);
    const directory = tab ? tab.directory : null;

    let content = null;
    if (directory) {
      try {
        content = await window.attune.readClaudeMd(directory);
      } catch (e) {
        content = null;
      }
    }

    const overlay = document.createElement('div');
    overlay.className = 'instructions-overlay';

    if (!content) {
      overlay.innerHTML = `
        <div class="instructions-card">
          <div class="instructions-header">
            <div>
              <div class="instructions-title">Project Instructions</div>
            </div>
            <button class="instructions-close">&times;</button>
          </div>
          <div class="instructions-empty">No CLAUDE.md found in this directory</div>
        </div>
      `;
    } else {
      const escaped = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const shortPath = this.shortenPath(directory);
      overlay.innerHTML = `
        <div class="instructions-card">
          <div class="instructions-header">
            <div>
              <div class="instructions-title">Project Instructions</div>
              <div class="instructions-subtitle">${shortPath}</div>
            </div>
            <button class="instructions-close">&times;</button>
          </div>
          <div class="instructions-content">${escaped}</div>
        </div>
      `;
    }

    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
    };

    overlay.querySelector('.instructions-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
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
    if (this._saveStateTimer) return; // Already scheduled
    this._saveStateTimer = setTimeout(() => {
      this._saveStateTimer = null;
      this._flushSessionState();
    }, 1000);
  }

  _flushSessionState() {
    // Cancel any pending debounced save since we're flushing now
    if (this._saveStateTimer) {
      clearTimeout(this._saveStateTimer);
      this._saveStateTimer = null;
    }

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

}

// Prevent Electron from navigating when files are dropped outside terminal area
document.addEventListener('dragover', (e) => {
  e.preventDefault();
}, true);
document.addEventListener('drop', (e) => {
  e.preventDefault();
}, true);

document.addEventListener('DOMContentLoaded', () => {
  const app = new AttuneApp();
  app.init();

  // Collapsible sidebar sections — accordion (only one open at a time)
  const collapsibleSections = document.querySelectorAll('.sidebar-section-header.collapsible');
  collapsibleSections.forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.sidebar-section');
      const isCollapsed = section.classList.contains('collapsed');

      if (isCollapsed) {
        // Collapse all other collapsible sections first
        collapsibleSections.forEach(otherHeader => {
          const otherSection = otherHeader.closest('.sidebar-section');
          if (otherSection !== section) {
            otherSection.classList.add('collapsed');
          }
        });
        // Open this one
        section.classList.remove('collapsed');
      } else {
        // Close this section
        section.classList.add('collapsed');
      }
    });
  });
});
