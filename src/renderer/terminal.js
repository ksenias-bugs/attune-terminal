import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

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
    this.statusCheckInterval = null;

    this.terminal = new Terminal({
      theme: getTerminalTheme(isDark),
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: 14,
      lineHeight: 1.0,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'bar',
      macOptionIsMeta: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
  }

  async start(command) {
    this.terminal.open(this.container);

    // Load WebGL renderer for pixel-perfect block character rendering
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch (e) {
      // WebGL not available, fall back to canvas (block chars may have gaps)
    }

    // Fit after a frame to ensure container has dimensions
    requestAnimationFrame(() => {
      this.fitAddon.fit();
    });

    // Create PTY on main process
    await window.attune.createPty(this.id, this.directory, command || 'claude');

    // Receive PTY output
    const cleanupData = window.attune.onPtyData(this.id, (data) => {
      this.terminal.write(data);
      this.processOutput(data);
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
      }
      return true;
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
      window.attune.resizePty(this.id, this.terminal.cols, this.terminal.rows);
    });
    resizeObserver.observe(this.container);
    this.cleanupFns.push(() => resizeObserver.disconnect());

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
    // Check approval first (highest priority)
    if (/[Aa]llow|[Aa]pprove|[Yy]\/[Nn]|[Pp]ermission|Yes\/No/.test(lastChunk.slice(-300))) {
      newStatus = 'approval';
    }
    // Check for Claude Code's input prompt — it shows > when waiting for user input
    // Also check for the prompt appearing after a response ends
    else if (/>\s*$/.test(tail) || /❯\s*$/.test(tail) || /\?\s*$/.test(tail.slice(-30))) {
      newStatus = 'waiting';
    }
    // Detect active work states
    else if (/[Tt]hinking|[Pp]lanning|ultra-thinking/i.test(lastChunk.slice(-300))) {
      newStatus = 'thinking';
    } else if (/[Aa]gent|subagent|[Ss]pawning/i.test(lastChunk.slice(-300))) {
      newStatus = 'agents';
    } else if (/[Rr]eading|[Ww]riting|[Ee]diting|[Ss]earching|[Rr]unning/i.test(lastChunk.slice(-300))) {
      newStatus = 'tools';
    } else if (this.status === 'launching') {
      newStatus = 'working';
    }

    if (newStatus !== this.status) {
      const prevStatus = this.status;
      this.setStatus(newStatus);

      // Notify when Claude needs attention (only for meaningful transitions)
      if (newStatus === 'approval') {
        window.attune.notify('Action Required: Claude needs permission', 'A tool use is waiting for your approval.');
      } else if (newStatus === 'waiting' && prevStatus !== 'launching' && prevStatus !== 'waiting') {
        window.attune.notify('Claude finished the task', 'Ready for your next message.');
      }
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

  focus() {
    this.terminal.focus();
    requestAnimationFrame(() => this.fitAddon.fit());
  }

  destroy() {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    window.attune.destroyPty(this.id);
    this.terminal.dispose();
  }
}
