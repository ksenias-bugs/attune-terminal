const SLASH_COMMANDS = [
  { name: '/sales-sync', desc: 'Weekly sales pipeline sync', category: 'sync' },
  { name: '/cs-sync', desc: 'Customer success sync', category: 'sync' },
  { name: '/partner-sync', desc: 'Partner ecosystem sync', category: 'sync' },
  { name: '/marketing-sync', desc: 'Marketing initiatives sync', category: 'sync' },
  { name: '/pmw', desc: 'Process meeting transcript', category: 'work' },
  { name: '/expense-recon', desc: 'Reconcile Ramp expenses', category: 'work' },
  { name: '/new-transcript-sort', desc: 'Sort new transcripts', category: 'work' },
  { name: '/client-email-sync', desc: 'Sync client emails', category: 'work' },
  { name: '/relationship-timeline', desc: 'Build client timeline', category: 'work' },
  { name: '/brand-voice', desc: 'Draft in Attune voice', category: 'create' },
  { name: '/brand-visual', desc: 'Create presentations/decks', category: 'create' },
  { name: '/meeting-roi', desc: 'Evaluate meeting ROI', category: 'create' },
  { name: '/setup-mcp', desc: 'Set up MCP servers', category: 'system' },
  { name: '/second-brain-onboarding', desc: 'Learn the system', category: 'system' },
  { name: '/archive-logs', desc: 'Archive daily logs', category: 'system' },
];

const STATUS_CONFIG = {
  launching: { label: 'Launching...', cssClass: 'status-launching' },
  waiting: { label: 'Waiting for input', cssClass: 'status-waiting' },
  working: { label: 'Working...', cssClass: 'status-working' },
  thinking: { label: 'Thinking...', cssClass: 'status-working' },
  agents: { label: 'Running agents...', cssClass: 'status-working' },
  tools: { label: 'Using tools...', cssClass: 'status-working' },
  approval: { label: 'Needs your approval', cssClass: 'status-approval' },
  exited: { label: 'Session ended', cssClass: 'status-exited' },
};

const TIPS_BY_STATUS = {
  launching: [
    'Claude Code is starting up. This takes a few seconds.',
  ],
  waiting: [
    'Type your request or click a command from the sidebar',
    'Type <kbd>/</kbd> to see all available commands',
    'Press <kbd>Up</kbd> to recall your last message',
  ],
  working: [
    'Claude is working. You can scroll up to review progress.',
    'Press <kbd>Esc</kbd> twice to interrupt if needed',
  ],
  thinking: [
    'Claude is thinking through your request',
    'Long pauses are normal for complex tasks',
  ],
  agents: [
    'Sub-agents are running. This can take several minutes.',
    'You can scroll up to see agent activity',
  ],
  tools: [
    'Claude is reading, writing, or searching files',
  ],
  approval: [
    'Claude needs your permission to proceed',
    'Press <kbd>y</kbd> to approve or <kbd>n</kbd> to deny',
    'Press <kbd>Esc</kbd> to cancel the operation',
  ],
  exited: [
    'Type <kbd>claude</kbd> to start a new session',
    'Or close this tab and open a new one',
  ],
};

export class Sidebar {
  constructor(onCommandClick) {
    this.onCommandClick = onCommandClick;
    this.commandListEl = document.getElementById('slash-commands');
    this.statusEl = document.getElementById('session-status');
    this.tipsEl = document.getElementById('quick-tips');
    this.sessionListEl = document.getElementById('session-list');

    this.renderCommands();
    this.updateStatus('launching', 0);
  }

  renderCommands() {
    this.commandListEl.innerHTML = '';
    for (const cmd of SLASH_COMMANDS) {
      const item = document.createElement('div');
      item.className = 'command-item';
      item.innerHTML = `
        <span class="command-name">${cmd.name}</span>
        <span class="command-desc">${cmd.desc}</span>
      `;
      item.addEventListener('click', () => {
        if (this.onCommandClick) {
          this.onCommandClick(cmd.name);
        }
      });
      this.commandListEl.appendChild(item);
    }
  }

  updateStatus(status, elapsedMs) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.working;
    const elapsed = this.formatElapsed(elapsedMs);

    this.statusEl.innerHTML = `
      <div class="status-indicator ${config.cssClass}"></div>
      <span class="status-text">${config.label}</span>
      ${elapsed ? `<span class="status-elapsed">${elapsed}</span>` : ''}
    `;

    this.renderTips(status);
  }

  renderTips(status) {
    const tips = TIPS_BY_STATUS[status] || TIPS_BY_STATUS.working;
    this.tipsEl.innerHTML = tips
      .map((tip) => `<div class="tip-item">${tip}</div>`)
      .join('');
  }

  updateSessions(sessions, activeId) {
    this.sessionListEl.innerHTML = '';
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = `session-item ${session.id === activeId ? 'active' : ''}`;
      const dirName = session.directory.split('/').pop() || session.directory;
      const time = new Date(session.startTime).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      item.innerHTML = `
        <div class="tab-status ${session.status === 'waiting' ? 'waiting' : session.status === 'exited' ? '' : 'working'}"></div>
        <span class="session-dir" title="${session.directory}">${dirName}</span>
        <span class="session-time">${time}</span>
      `;
      this.sessionListEl.appendChild(item);
    }
  }

  formatElapsed(ms) {
    if (!ms || ms < 5000) return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
  }
}
