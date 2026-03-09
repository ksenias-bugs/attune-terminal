export class FileExplorer {
  constructor(onFileClick) {
    this.onFileClick = onFileClick;
    this.currentDir = null;
    this.homeDir = null;
    this.panelEl = document.getElementById('file-explorer');
    this.treeEl = document.getElementById('file-tree');
  }

  async setDirectory(dirPath) {
    if (!this.homeDir) this.homeDir = dirPath;
    this.currentDir = dirPath;
    await this.render();
  }

  async navigateTo(dirPath) {
    this.currentDir = dirPath;
    await this.render();
  }

  async render() {
    if (!this.currentDir) {
      this.treeEl.innerHTML = '<div class="file-explorer-empty">No directory selected</div>';
      return;
    }

    this.treeEl.innerHTML = '';

    // Current directory label
    const dirLabel = document.createElement('div');
    dirLabel.className = 'file-explorer-dir-label';
    dirLabel.textContent = this.currentDir.split('/').pop() || '/';
    dirLabel.title = this.currentDir;
    this.treeEl.appendChild(dirLabel);

    // "Go up" row
    if (this.currentDir !== '/') {
      const upRow = document.createElement('div');
      upRow.className = 'file-row file-row-up';
      upRow.innerHTML = '<span class="file-icon">↑</span><span class="file-name">..</span>';
      upRow.addEventListener('click', () => {
        const parent = this.currentDir.replace(/\/[^/]+\/?$/, '') || '/';
        this.navigateTo(parent);
      });
      this.treeEl.appendChild(upRow);
    }

    // List contents of current directory (flat, no nesting)
    const items = await window.attune.listDirectory(this.currentDir);

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'file-row';

      if (item.isDirectory) {
        row.innerHTML = `
          <span class="file-icon file-icon-folder">▸</span>
          <span class="file-name folder-name">${item.name}</span>
        `;
        row.addEventListener('click', () => {
          this.navigateTo(item.path);
        });
      } else {
        const ext = item.name.split('.').pop().toLowerCase();
        const icon = this.getFileIcon(ext);
        row.innerHTML = `
          <span class="file-icon">${icon}</span>
          <span class="file-name">${item.name}</span>
        `;
        row.addEventListener('click', () => {
          if (this.onFileClick) {
            const filePath = item.path.includes(' ') ? `"${item.path}"` : item.path;
            this.onFileClick(filePath);
          }
        });
      }

      this.treeEl.appendChild(row);
    }
  }

  getFileIcon(ext) {
    const icons = {
      md: '📝', txt: '📄', pdf: '📕',
      js: '📜', ts: '📜', json: '📋',
      csv: '📊', xlsx: '📊', xls: '📊',
      png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼',
      doc: '📄', docx: '📄',
    };
    return icons[ext] || '📄';
  }
}
