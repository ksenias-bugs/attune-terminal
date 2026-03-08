import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const TERMINAL_THEME = {
  background: '#12131e',
  foreground: '#e1e2e8',
  cursor: '#e1e2e8',
  cursorAccent: '#12131e',
  selectionBackground: '#3a3b5c',
  selectionForeground: '#e1e2e8',
  black: '#1a1b2e',
  red: '#e06c75',
  green: '#7cc88d',
  yellow: '#e5c76b',
  blue: '#6c8cff',
  magenta: '#c78cfa',
  cyan: '#56c8d8',
  white: '#e1e2e8',
  brightBlack: '#5c5d76',
  brightRed: '#e88991',
  brightGreen: '#98d6a5',
  brightYellow: '#edd48d',
  brightBlue: '#8ea8ff',
  brightMagenta: '#d4a6fb',
  brightCyan: '#78d8e6',
  brightWhite: '#f0f1f5',
};

export class TerminalSession {
  constructor(id, directory, container, onStatusChange) {
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
      theme: TERMINAL_THEME,
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
  }

  async start() {
    this.terminal.open(this.container);

    // Fit after a frame to ensure container has dimensions
    requestAnimationFrame(() => {
      this.fitAddon.fit();
    });

    // Create PTY on main process
    await window.attune.createPty(this.id, this.directory, true);

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
      this.setStatus(newStatus);
    }
  }

  setStatus(status) {
    this.status = status;
    this.statusTime = Date.now();
    if (this.onStatusChange) {
      this.onStatusChange(status, 0);
    }
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
