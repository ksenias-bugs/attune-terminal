export class Sidebar {
  constructor(onCommandClick, onSessionClick) {
    this.onCommandClick = onCommandClick;
    this.onSessionClick = onSessionClick;
    this.commandListEl = document.getElementById('slash-commands');
    this.recentSessionsEl = document.getElementById('recent-sessions');
    this.currentDirectory = null;
    this._currentCommandsDir = null;
    this._currentSessionsDir = null;

    this.renderCommands([]);
  }

  renderCommands(commands) {
    this.commandListEl.innerHTML = '';
    if (!commands || commands.length === 0) {
      this.commandListEl.innerHTML = '<div class="recent-sessions-empty">No commands found</div>';
      return;
    }
    for (const cmd of commands) {
      const item = document.createElement('div');
      item.className = 'command-item';
      item.innerHTML = `
        <span class="command-name">${this.escapeHtml(cmd.name)}</span>
        <span class="command-desc">${this.escapeHtml(cmd.desc)}</span>
      `;
      item.addEventListener('click', () => {
        if (this.onCommandClick) {
          this.onCommandClick(cmd.name);
        }
      });
      this.commandListEl.appendChild(item);
    }
  }

  async loadCommands(directory) {
    // Avoid redundant reloads for the same directory
    if (directory === this._currentCommandsDir) return;
    this._currentCommandsDir = directory;
    try {
      const commands = await window.attune.getSlashCommands(directory);
      this.renderCommands(commands);
    } catch (e) {
      console.error('Failed to load slash commands:', e);
      this.renderCommands([]);
    }
  }

  async loadRecentSessions(directory) {
    if (directory === this._currentSessionsDir) return;
    this._currentSessionsDir = directory;

    if (!directory) {
      this.recentSessionsEl.innerHTML = '<div class="recent-sessions-empty">No recent sessions</div>';
      return;
    }

    this.currentDirectory = directory;

    try {
      const sessions = await window.attune.getRecentSessions(directory);
      if (!sessions || sessions.length === 0) {
        this.recentSessionsEl.innerHTML = '<div class="recent-sessions-empty">No recent sessions</div>';
        return;
      }

      this.recentSessionsEl.innerHTML = '';
      for (const session of sessions) {
        const item = document.createElement('div');
        item.className = 'recent-session-item';

        const relTime = this.formatRelativeTime(session.timestamp);
        const preview = session.preview || '(empty session)';

        item.innerHTML = `
          <div class="recent-session-top">
            <span class="recent-session-time">${relTime}</span>
          </div>
          <span class="recent-session-preview" title="${this.escapeHtml(preview)}">${this.escapeHtml(preview)}</span>
        `;

        if (session.id && this.onSessionClick) {
          item.addEventListener('click', () => {
            this.onSessionClick(session.id);
          });
        }

        this.recentSessionsEl.appendChild(item);
      }
    } catch (e) {
      this.recentSessionsEl.innerHTML = '<div class="recent-sessions-empty">Could not load sessions</div>';
    }
  }

  formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
    return `${Math.floor(diffDay / 30)}mo ago`;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
