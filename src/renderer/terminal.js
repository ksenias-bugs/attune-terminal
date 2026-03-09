import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

const LIGHT_THEME = {
  background: '#FFFFFF',            // White — default surface
  foreground: '#0F172A',            // Ink — primary text
  cursor: '#145456',                // Deep Teal — brand primary
  cursorAccent: '#FFFFFF',          // White
  selectionBackground: '#cde4e2',   // Soft teal selection
  selectionForeground: '#0F172A',   // Ink
  // ANSI colors — kept recognizable, tuned for contrast on white
  black: '#0F172A',                 // Ink
  red: '#c0392b',
  green: '#2d6a4f',
  yellow: '#b87d08',
  blue: '#145456',                  // Deep Teal as blue
  magenta: '#5b4a8a',
  cyan: '#0D9488',                  // Teal
  white: '#6b7f9e',                 // Muted Dark Slate
  brightBlack: '#1C263D',           // Dark Slate
  brightRed: '#EA580C',             // Orange accent
  brightGreen: '#3a9066',
  brightYellow: '#EA580C',          // Orange accent
  brightBlue: '#0D9488',            // Teal
  brightMagenta: '#7a65a6',
  brightCyan: '#145456',            // Deep Teal
  brightWhite: '#F8F8F8',           // Light Gray
};

const DARK_THEME = {
  background: '#0F172A',            // Ink — brand darkest
  foreground: '#F8F8F8',            // Light Gray — primary text on dark
  cursor: '#0D9488',                // Teal — brand cursor
  cursorAccent: '#0F172A',          // Ink
  selectionBackground: '#253350',   // Lightened Dark Slate
  selectionForeground: '#F8F8F8',   // Light Gray
  // ANSI colors — kept recognizable, tuned for contrast on Ink background
  black: '#1C263D',                 // Dark Slate
  red: '#e06c75',
  green: '#7cc88d',
  yellow: '#FF9A26',                // Warm Gold (per §4.2 dark pairing rule)
  blue: '#0D9488',                  // Teal
  magenta: '#b094d4',
  cyan: '#5cc0b3',                  // Lightened teal for readability
  white: '#F8F8F8',                 // Light Gray
  brightBlack: '#5c7090',           // Muted slate
  brightRed: '#e88991',
  brightGreen: '#98d6a5',
  brightYellow: '#FF9A26',          // Warm Gold
  brightBlue: '#5cc0b3',            // Lightened teal
  brightMagenta: '#c8aee0',
  brightCyan: '#0D9488',            // Teal
  brightWhite: '#FFFFFF',           // White
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

    let newStatus = this.status;

    // Detect Claude Code states from output patterns
    if (/Allow|approve|[Yy]\/[Nn]|permission/.test(lastChunk.slice(-200))) {
      newStatus = 'approval';
    } else if (/❯\s*$|>\s*$|\?\s*$/.test(lastChunk.slice(-50))) {
      newStatus = 'waiting';
    } else if (/[Tt]hinking|[Pp]lanning/.test(lastChunk.slice(-200))) {
      newStatus = 'thinking';
    } else if (/[Aa]gent|subagent|[Ss]pawning/.test(lastChunk.slice(-200))) {
      newStatus = 'agents';
    } else if (/[Rr]eading|[Ww]riting|[Ee]diting|[Ss]earching/.test(lastChunk.slice(-200))) {
      newStatus = 'tools';
    } else if (this.status === 'launching') {
      newStatus = 'working';
    }

    if (newStatus !== this.status) {
      const prevStatus = this.status;
      this.setStatus(newStatus);

      // Notify when Claude needs attention (only for meaningful transitions)
      if (newStatus === 'approval') {
        window.attune.notify('Claude needs your approval', 'A tool use is waiting for permission.');
      } else if (newStatus === 'waiting' && prevStatus !== 'launching' && prevStatus !== 'waiting') {
        window.attune.notify('Claude is done', 'Ready for your next message.');
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
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
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
