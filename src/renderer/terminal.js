import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';

const LIGHT_THEME = {
  background: '#FAFAF8',            // Off-white — default surface
  foreground: '#1A1A1A',            // Near-black — primary text
  cursor: '#C4795B',                // Warm amber — brand cursor
  cursorAccent: '#FAFAF8',          // Off-white
  selectionBackground: '#E8D5C4',   // Warm selection
  selectionForeground: '#1A1A1A',   // Near-black
  // ANSI colors — kept recognizable, tuned for contrast on off-white
  black: '#1A1A1A',                 // Near-black
  red: '#c0392b',
  green: '#2d6a4f',
  yellow: '#b87d08',
  blue: '#2563EB',                  // Standard blue
  magenta: '#5b4a8a',
  cyan: '#0D9488',                  // Teal (secondary accent)
  white: '#8A8580',                 // Warm muted
  brightBlack: '#404040',           // Dark gray
  brightRed: '#EA580C',             // Orange accent
  brightGreen: '#3a9066',
  brightYellow: '#C4795B',          // Amber accent
  brightBlue: '#0D9488',            // Teal
  brightMagenta: '#7a65a6',
  brightCyan: '#145456',            // Deep Teal
  brightWhite: '#F5F3EF',           // Cream
};

const DARK_THEME = {
  background: '#1A1A1A',            // Dark gray — base background
  foreground: '#F5F3EF',            // Off-white/cream — primary text
  cursor: '#D4956B',                // Warm amber — brand cursor
  cursorAccent: '#1A1A1A',          // Dark gray
  selectionBackground: '#5C4A3A',   // Warm dark selection
  selectionForeground: '#F5F3EF',   // Off-white
  // ANSI colors — kept recognizable, tuned for contrast on dark gray
  black: '#2D2D2D',                 // Medium dark gray
  red: '#e06c75',
  green: '#7cc88d',
  yellow: '#D4956B',                // Warm amber
  blue: '#6CA6E8',                  // Soft blue
  magenta: '#b094d4',
  cyan: '#5cc0b3',                  // Light teal (secondary)
  white: '#F5F3EF',                 // Off-white
  brightBlack: '#787370',           // Warm muted gray
  brightRed: '#e88991',
  brightGreen: '#98d6a5',
  brightYellow: '#EA580C',          // Orange accent
  brightBlue: '#5cc0b3',            // Light teal
  brightMagenta: '#c8aee0',
  brightCyan: '#0D9488',            // Teal
  brightWhite: '#FAFAF8',           // Off-white
};

export function getTerminalTheme(isDark) {
  return isDark ? DARK_THEME : LIGHT_THEME;
}

export class TerminalSession {
  constructor(id, directory, container, onStatusChange, isDark) {
    this.id = id;
    this.directory = directory;
    this.container = container;
    this.onStatusChange = onStatusChange;
    this.status = 'launching';
    this.statusTime = Date.now();
    this.startTime = Date.now();
    this.cleanupFns = [];
    this.recentOutput = '';
    this.maxBuffer = 5000;
    this.tokenCount = 0;
    this.estimatedCost = '';
    this.statusCheckInterval = null;
    this.lastNotifyTime = 0;
    this.notifyCooldownMs = 10000; // 10 second cooldown between notifications
    this._fitDebounceTimer = null;
    this._userScrolledUp = false;
    this.onSessionExit = null;
    this._processThrottleTimer = null;
    this._pendingOutput = '';

    const savedFontSize = parseInt(localStorage.getItem('attune-font-size')) || 14;

    this.terminal = new Terminal({
      theme: getTerminalTheme(isDark),
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: savedFontSize,
      lineHeight: 1.2,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'bar',
      macOptionIsMeta: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => {
      window.attune.openExternalUrl(uri);
    }));

    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
  }

  // Check if the terminal viewport is scrolled to (or near) the bottom
  _isAtBottom() {
    const buf = this.terminal.buffer.active;
    const viewportTop = buf.viewportY;
    const totalRows = buf.baseY;
    // Consider "at bottom" if within 2 rows of the end
    return viewportTop >= totalRows - 2;
  }

  // Debounced fit that preserves scroll position.
  // FitAddon.fit() calls _renderService.clear() + resize() which can
  // jump the viewport to the top of the scrollback buffer. We save the
  // viewport state before fit and restore it afterward.
  _safeFit() {
    if (this._fitDebounceTimer) {
      clearTimeout(this._fitDebounceTimer);
    }
    this._fitDebounceTimer = setTimeout(() => {
      this._fitDebounceTimer = null;
      const wasAtBottom = this._isAtBottom();
      const prevViewportY = this.terminal.buffer.active.viewportY;

      this.fitAddon.fit();
      // Also update the PTY dimensions so the shell knows the new size
      window.attune.resizePty(this.id, this.terminal.cols, this.terminal.rows);

      // After fit, restore scroll position
      if (wasAtBottom) {
        this.terminal.scrollToBottom();
      } else {
        // Clamp to valid range after resize (baseY may have changed)
        const maxY = this.terminal.buffer.active.baseY;
        const targetY = Math.min(prevViewportY, maxY);
        this.terminal.scrollToLine(targetY);
      }
    }, 50);
  }

  async start(command) {
    this.terminal.open(this.container);

    // Load WebGL renderer for pixel-perfect block character rendering
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch (e) {
      // WebGL not available, fall back to canvas (block chars may have gaps)
    }

    // Track user scroll: detect when the user scrolls away from bottom
    this.terminal.onScroll(() => {
      this._userScrolledUp = !this._isAtBottom();
    });

    // Fit after a frame to ensure container has dimensions
    requestAnimationFrame(() => {
      this.fitAddon.fit();
    });

    // Create PTY on main process
    await window.attune.createPty(this.id, this.directory, command || 'claude');

    // Receive PTY output
    const cleanupData = window.attune.onPtyData(this.id, (data) => {
      this.terminal.write(data);
      // xterm.js auto-scrolls on write only when the viewport is already at
      // the bottom. If a fit() call displaced the viewport, force it back
      // so the user can follow new output in real time.
      if (!this._userScrolledUp) {
        this.terminal.scrollToBottom();
      }
      this._pendingOutput += data;
      if (!this._processThrottleTimer) {
        this._processThrottleTimer = setTimeout(() => {
          this._processThrottleTimer = null;
          this.processOutput(this._pendingOutput);
          this._pendingOutput = '';
        }, 200);
      }
    });
    this.cleanupFns.push(cleanupData);

    // Handle PTY exit
    const cleanupExit = window.attune.onPtyExit(this.id, (code) => {
      this.setStatus('exited');
      this.terminal.write(`\r\n\x1b[90m[Session ended with code ${code}]\x1b[0m\r\n`);
    });
    this.cleanupFns.push(cleanupExit);

    // Send terminal input to PTY
    this.terminal.onData((data) => {
      window.attune.sendInput(this.id, data);
    });

    // Translate macOS Cmd shortcuts to terminal equivalents
    this.terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.metaKey) {
        // Cmd+Backspace → Ctrl+U (kill line backward)
        if (e.key === 'Backspace') {
          window.attune.sendInput(this.id, '\x15');
          return false;
        }
        // Cmd+Left → Ctrl+A (beginning of line)
        if (e.key === 'ArrowLeft') {
          window.attune.sendInput(this.id, '\x01');
          return false;
        }
        // Cmd+Right → Ctrl+E (end of line)
        if (e.key === 'ArrowRight') {
          window.attune.sendInput(this.id, '\x05');
          return false;
        }
        // Cmd+K → Ctrl+K (kill line forward)
        if (e.key === 'k') {
          window.attune.sendInput(this.id, '\x0b');
          return false;
        }
        // Cmd+F → Let it bubble to the document handler for search bar
        if (e.key === 'f') {
          return false;
        }
        // Cmd+D / Cmd+Shift+D → Let it bubble for split pane
        if (e.key === 'd') {
          return false;
        }
      }
      return true;
    });

    // Handle resize — delegates to _safeFit() which handles debouncing and scroll preservation
    const resizeObserver = new ResizeObserver(() => {
      this._safeFit();
    });
    resizeObserver.observe(this.container);
    this.cleanupFns.push(() => {
      resizeObserver.disconnect();
    });

    // Periodic status check (for elapsed time updates)
    this.statusCheckInterval = setInterval(() => {
      if (this.onStatusChange) {
        this.onStatusChange(this.status, this.getElapsed());
      }
    }, 1000);
    this.cleanupFns.push(() => clearInterval(this.statusCheckInterval));
  }

  processOutput(data) {
    this.recentOutput += data;
    if (this.recentOutput.length > this.maxBuffer) {
      this.recentOutput = this.recentOutput.slice(-this.maxBuffer);
    }

    const clean = this.stripAnsi(this.recentOutput);
    const lastChunk = clean.slice(-800);
    const tail = lastChunk.slice(-100);

    let newStatus = this.status;

    // Detect Claude Code states from output patterns
    // Check approval first (highest priority) — look for the actual permission prompt
    // patterns that Claude Code uses, not generic words in output text
    if (/Do you want to (allow|proceed|approve)|Allow once|Allow always|[Yy]\/[Nn]\]?\s*$/.test(lastChunk.slice(-300))) {
      newStatus = 'approval';
    }
    // Check for Claude Code's input prompt — the > at end of line when waiting
    // Must be on its own line (start of line or after newline), not part of output text
    else if (/\n>\s*$/.test(tail) || /^>\s*$/.test(tail.trim()) || /❯\s*$/.test(tail)) {
      newStatus = 'waiting';
    }
    // Detect active work states — use word boundaries and specific tool patterns
    // to avoid matching these words inside normal prose output
    else if (/\b(Thinking|Planning|ultra-thinking)\b/.test(lastChunk.slice(-150))) {
      newStatus = 'thinking';
    } else if (/\b(Agent|subagent|Spawning)\b/.test(lastChunk.slice(-150))) {
      newStatus = 'agents';
    } else if (/\b(Read|Write|Edit|Search|Glob|Grep|Bash|Run)\b/.test(lastChunk.slice(-150))) {
      newStatus = 'tools';
    } else if (this.status === 'launching') {
      newStatus = 'working';
    }

    // Detect Claude exit (drops back to shell prompt)
    if (this.status !== 'exited' && /Resume this session with:/.test(lastChunk)) {
      this.setStatus('exited');
      if (this.onSessionExit) this.onSessionExit();
    }

    if (newStatus !== this.status) {
      const prevStatus = this.status;
      this.setStatus(newStatus);

      // Notify ONLY for approval and waiting-after-active-work transitions.
      // All other status changes (thinking, tools, agents, working) are silent.
      const isActiveState = (s) => ['thinking', 'tools', 'agents', 'working'].includes(s);
      const now = Date.now();
      const cooldownOk = (now - this.lastNotifyTime) >= this.notifyCooldownMs;

      if (newStatus === 'approval' && cooldownOk) {
        this.lastNotifyTime = now;
        window.attune.notify('Action Required: Claude needs permission', 'A tool use is waiting for your approval.', 'approval');
      } else if (newStatus === 'waiting' && isActiveState(prevStatus) && cooldownOk) {
        this.lastNotifyTime = now;
        window.attune.notify('Claude finished the task', 'Ready for your next message.', 'waiting');
      }
    }

    // Parse cost and context info from Claude Code's status bar
    // Format: "Opus 4.6  |  Team Resources  |  ctx: 12% used / 88% left  |  $0.16"
    const costMatch = clean.match(/\|\s*\$(\d+\.\d+)/);
    if (costMatch) {
      this.estimatedCost = '$' + costMatch[1];
    }
    const ctxMatch = clean.match(/ctx:\s*(\d+)%\s*used/);
    if (ctxMatch) {
      this.contextPercent = parseInt(ctxMatch[1]);
    }
  }

  setStatus(status) {
    this.status = status;
    this.statusTime = Date.now();
    if (this.onStatusChange) {
      this.onStatusChange(status, 0);
    }
  }

  setTheme(isDark) {
    this.terminal.options.theme = getTerminalTheme(isDark);
  }

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    this._safeFit();
  }

  stripAnsi(str) {
    return str
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (cursor, color, etc.)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b[()][A-Z0-9]/g, '')          // Character set selection
      .replace(/\x1b[78DEHM]/g, '')               // Single-char escapes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Control chars (keep \n \r \t)
  }

  getElapsed() {
    return Date.now() - this.statusTime;
  }

  sendCommand(command) {
    window.attune.sendInput(this.id, command + '\r');
  }

  findNext(query, options) {
    this.searchAddon.findNext(query, options);
  }

  findPrevious(query, options) {
    this.searchAddon.findPrevious(query, options);
  }

  clearSearch() {
    this.searchAddon.clearDecorations();
  }

  focus() {
    this.terminal.focus();
    requestAnimationFrame(() => this._safeFit());
  }

  destroy() {
    if (this._fitDebounceTimer) {
      clearTimeout(this._fitDebounceTimer);
      this._fitDebounceTimer = null;
    }
    if (this._processThrottleTimer) {
      clearTimeout(this._processThrottleTimer);
      this._processThrottleTimer = null;
    }
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    window.attune.destroyPty(this.id);
    this.terminal.dispose();
  }
}
