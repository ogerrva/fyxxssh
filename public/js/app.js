// FYXXSSH Studio - Frontend Core Engine v1.0 Pro
let hosts = [];
let shortcuts = [];
let userSettings = { theme: 'obsidian', layout: 'split-vertical' };
let activeSession = null;
let xtermInstance = null;
let fitAddon = null;
let searchAddon = null;
let terminalSocket = null;

// SFTP Estado & Histórico de Navegação
let currentSftpPath = '/root';
let sftpHistory = ['/root'];
let sftpHistoryIndex = 0;
let currentSftpItems = [];
let activeContextItem = null;

// Conflitos de Transferência & Modais
let confirmResolver = null;
let conflictResolver = null;
let batchConflictChoice = null;

// Editor & Telemetria
let currentEditingFile = null;
let telemetryTimer = null;
let homeSearchQuery = '';

// =================== INICIALIZAÇÃO ===================
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) {
    lucide.createIcons();
  }
  await loadUserSettings();
  await loadHosts();
  await loadShortcuts();
  setupDragAndDrop();
  setupGlobalEvents();
  window.addEventListener('resize', handleWindowResize);
  
  // Checagem automática e silenciosa de atualizações no GitHub
  setTimeout(() => {
    checkAppUpdates(true);
  }, 2500);
});

// =================== CONTROLES DE JANELA NATIVA (ELECTRON) ===================
function winMinimize() {
  if (window.electronAPI && window.electronAPI.minimize) {
    window.electronAPI.minimize();
  }
}

function winMaximize() {
  if (window.electronAPI && window.electronAPI.maximize) {
    window.electronAPI.maximize();
  }
}

function winClose() {
  if (window.electronAPI && window.electronAPI.close) {
    window.electronAPI.close();
  } else {
    window.close();
  }
}

// =================== NOTIFICAÇÕES TOAST ===================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

// =================== MODAL DE CONFIRMAÇÃO ESTILIZADO (ZERO POPUPS DO WINDOWS) ===================
function showConfirmModal({ title = 'Confirmar Ação', message = 'Deseja prosseguir?', confirmText = 'Confirmar', isDanger = true }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const okBtn = document.getElementById('confirmModalOkBtn');
    
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (okBtn) {
      okBtn.textContent = confirmText;
      okBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
    }
    openModal('confirmModal');
  });
}

function closeConfirmModal(result) {
  closeModal('confirmModal');
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

// =================== CONFIGURAÇÕES & TEMAS ===================
async function loadUserSettings() {
  try {
    const res = await fetch('/api/settings');
    userSettings = await res.json();
    applyTheme(userSettings.theme || 'obsidian', false);
    if (userSettings.layout) {
      setSessionLayout(userSettings.layout, false);
    }
  } catch (e) {
    applyTheme('obsidian', false);
  }
}

function applyTheme(themeName, persist = true) {
  document.body.className = '';
  document.body.classList.add(`theme-${themeName}`);
  
  document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
  const card = document.getElementById(`theme-card-${themeName}`);
  if (card) card.classList.add('active');

  userSettings.theme = themeName;
  if (persist) {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: themeName })
    }).catch(() => {});
    showToast(`Tema ativado: ${themeName.toUpperCase()}`, 'success');
  }

  updateXtermTheme(themeName);
}

function updateXtermTheme(themeName) {
  const themeObj = getXtermThemeObject(themeName);
  sessionTabs.forEach(tab => {
    if (tab.xterm) {
      tab.xterm.options.theme = themeObj;
    }
  });
}

function setSessionLayout(layoutName, persist = true) {
  const area = document.getElementById('sessionSplitArea');
  if (!area) return;

  area.classList.remove('layout-split-vertical', 'layout-split-horizontal', 'layout-terminal-focus', 'layout-sftp-focus');
  area.classList.add(`layout-${layoutName}`);

  const btnV = document.getElementById('layoutSplitVBtn');
  const btnH = document.getElementById('layoutSplitHBtn');
  const btnTerm = document.getElementById('layoutTermBtn');
  const btnSftp = document.getElementById('layoutSftpBtn');

  if (btnV) btnV.classList.toggle('active', layoutName === 'split-vertical');
  if (btnH) btnH.classList.toggle('active', layoutName === 'split-horizontal');
  if (btnTerm) btnTerm.classList.toggle('active', layoutName === 'terminal-focus');
  if (btnSftp) btnSftp.classList.toggle('active', layoutName === 'sftp-focus');

  userSettings.layout = layoutName;
  if (persist) {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: layoutName })
    }).catch(() => {});
  }

  setTimeout(() => {
    if (fitAddon) {
      try { fitAddon.fit(); } catch (e) {}
    }
  }, 100);
}

// =================== NAVEGAÇÃO ENTRE TELAS ===================
function switchMainView(viewName) {
  const homeView = document.getElementById('homeView');
  const sessionView = document.getElementById('sessionView');
  const navHomeBtn = document.getElementById('navHomeBtn');
  const navSessionBtn = document.getElementById('navSessionBtn');
  const breadcrumbs = document.getElementById('activeBreadcrumbs');

  if (viewName === 'home') {
    homeView.classList.add('active');
    sessionView.classList.remove('active');
    navHomeBtn.classList.add('active');
    navSessionBtn.classList.remove('active');
    breadcrumbs.innerHTML = '<span class="crumb-root">Dashboard / Início</span>';
  } else if (viewName === 'session') {
    if (!activeSession) {
      showToast('Nenhuma sessão SSH ativa no momento.', 'info');
      return;
    }
    homeView.classList.remove('active');
    sessionView.classList.add('active');
    navHomeBtn.classList.remove('active');
    navSessionBtn.classList.add('active');
    navSessionBtn.style.display = 'flex';
    breadcrumbs.innerHTML = `<span class="crumb-root" onclick="switchMainView('home')">Início</span> <span class="crumb-sep">></span> <span class="crumb-current">${escapeHtml(activeSession.hostName)}</span>`;
    
    setTimeout(() => {
      if (fitAddon) {
        try { fitAddon.fit(); } catch (e) {}
      }
    }, 100);
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('appSidebar');
  sidebar.classList.toggle('collapsed');
}

// =================== CARREGAMENTO DE DADOS ===================
async function loadHosts() {
  try {
    const res = await fetch('/api/hosts');
    hosts = await res.json();
    renderSidebarHosts();
    renderHostsGrid();
    populateHostSelects();
    updateDashboardCounters();
  } catch (err) {
    console.error('Falha ao carregar servidores:', err);
  }
}

async function loadShortcuts() {
  try {
    const res = await fetch('/api/shortcuts');
    shortcuts = await res.json();
    renderShortcutsGrid();
    updateDashboardCounters();
  } catch (err) {
    console.error('Falha ao carregar atalhos:', err);
  }
}

function updateDashboardCounters() {
  const scCount = document.getElementById('statShortcutCount');
  const hostCount = document.getElementById('statHostCount');
  if (scCount) scCount.textContent = shortcuts.length;
  if (hostCount) hostCount.textContent = hosts.length;
}

function handleHomeSearch(query) {
  homeSearchQuery = (query || '').toLowerCase().trim();
  renderShortcutsGrid();
  renderHostsGrid();
}

function renderSidebarHosts() {
  const listEl = document.getElementById('sidebarHostsList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (hosts.length === 0) {
    listEl.innerHTML = `<div style="padding: 12px; font-size:11px; color:var(--text-muted); text-align:center;">Nenhum servidor</div>`;
    return;
  }

  hosts.forEach(host => {
    const item = document.createElement('div');
    item.className = 'sidebar-host-item';
    item.onclick = () => openSession(host.id, '/root', userSettings.layout || 'split-vertical');
    item.innerHTML = `
      <span class="host-dot" style="background-color: ${host.color || '#3b82f6'};"></span>
      <div class="sidebar-host-info">
        <span class="sidebar-host-name">${escapeHtml(host.name)}</span>
        <span class="sidebar-host-sub">${escapeHtml(host.host)}</span>
      </div>
    `;
    listEl.appendChild(item);
  });
}

function renderHostsGrid() {
  const gridEl = document.getElementById('hostsGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  let list = hosts;
  if (homeSearchQuery) {
    list = list.filter(h => 
      h.name.toLowerCase().includes(homeSearchQuery) || 
      h.host.toLowerCase().includes(homeSearchQuery) ||
      h.username.toLowerCase().includes(homeSearchQuery)
    );
  }

  if (list.length === 0) {
    if (hosts.length === 0) {
      gridEl.innerHTML = `
        <div class="clean-empty-state" style="grid-column: 1 / -1;">
          <div class="clean-empty-state-left">
            <i data-lucide="server"></i>
            <span>Nenhum servidor SSH adicionado ainda.</span>
          </div>
          <button class="btn-clean-mini" onclick="openHostModal()">
            <i data-lucide="plus"></i> Adicionar Servidor
          </button>
        </div>
      `;
    } else {
      gridEl.innerHTML = `<div style="grid-column: 1 / -1; color:var(--text-muted); font-size:12px; padding:10px;">Nenhum servidor corresponde à busca.</div>`;
    }
    if (window.lucide) lucide.createIcons();
    return;
  }

  list.forEach(host => {
    const card = document.createElement('div');
    card.className = 'host-card';
    card.innerHTML = `
      <div class="host-card-header">
        <div style="display:flex;align-items:center;gap:7px;">
          <span class="host-color-dot" style="background-color: ${host.color || '#3b82f6'};"></span>
          <span class="host-card-title">${escapeHtml(host.name)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button class="icon-btn-tiny" onclick="openEditHostModal('${host.id}')" title="Editar Servidor">
            <i data-lucide="edit-2"></i>
          </button>
          <button class="icon-btn-tiny" onclick="deleteHost('${host.id}')" title="Excluir Servidor">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
      <div class="host-details">
        <div><strong>IP:</strong> <span class="mono">${escapeHtml(host.host)}:${host.port || 22}</span> (${escapeHtml(host.username)})</div>
      </div>
      <div class="host-actions">
        <button class="btn-action-primary flex-1" onclick="openSession('${host.id}', '/root', 'terminal-focus')">
          <i data-lucide="terminal"></i> Terminal
        </button>
        <button class="btn-action-secondary flex-1" onclick="openSession('${host.id}', '/root', 'sftp-focus')">
          <i data-lucide="folder"></i> Arquivos
        </button>
      </div>
    `;
    gridEl.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

function populateHostSelects() {
  const scHostSelect = document.getElementById('scHostSelect');
  const shortcutHostFilter = document.getElementById('shortcutHostFilter');

  if (scHostSelect) {
    scHostSelect.innerHTML = '';
    hosts.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = `${h.name} (${h.host})`;
      scHostSelect.appendChild(opt);
    });
  }

  if (shortcutHostFilter) {
    const curFilter = shortcutHostFilter.value;
    shortcutHostFilter.innerHTML = '<option value="ALL">Todos os Servidores</option>';
    hosts.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = h.name;
      shortcutHostFilter.appendChild(opt);
    });
    if (curFilter) shortcutHostFilter.value = curFilter;
  }
}

function filterShortcutsByHost() {
  renderShortcutsGrid();
}

function renderShortcutsGrid() {
  const gridEl = document.getElementById('shortcutsGrid');
  if (!gridEl) return;
  const filterVal = document.getElementById('shortcutHostFilter') ? document.getElementById('shortcutHostFilter').value : 'ALL';
  gridEl.innerHTML = '';

  let filtered = filterVal === 'ALL' 
    ? shortcuts 
    : shortcuts.filter(s => s.hostId === filterVal);

  if (homeSearchQuery) {
    filtered = filtered.filter(s => 
      s.name.toLowerCase().includes(homeSearchQuery) || 
      s.path.toLowerCase().includes(homeSearchQuery)
    );
  }

  if (filtered.length === 0) {
    if (shortcuts.length === 0) {
      gridEl.innerHTML = `
        <div class="clean-empty-state" style="grid-column: 1 / -1;">
          <div class="clean-empty-state-left">
            <i data-lucide="folder-symlink"></i>
            <span>Nenhum atalho criado. Adicione atalhos para abrir direto em pastas como /opt/seu-app/.</span>
          </div>
          <button class="btn-clean-mini" onclick="openShortcutModal()">
            <i data-lucide="plus"></i> Novo Atalho
          </button>
        </div>
      `;
    } else {
      gridEl.innerHTML = `<div style="grid-column: 1 / -1; color:var(--text-muted); font-size:12px; padding:10px;">Nenhum atalho encontrado com o filtro atual.</div>`;
    }
    if (window.lucide) lucide.createIcons();
    return;
  }

  filtered.forEach(sc => {
    const host = hosts.find(h => h.id === sc.hostId) || { name: 'Servidor', host: '?' };
    const card = document.createElement('div');
    card.className = 'shortcut-card';

    let snippetsHtml = '';
    if (sc.snippets && sc.snippets.length > 0) {
      snippetsHtml = `
        <div class="card-snippets-row">
          ${sc.snippets.map(snp => `
            <span class="card-snippet-chip" onclick="openSessionAndRunSnippet('${sc.hostId}', '${escapeHtml(sc.path)}', '${escapeHtml(snp.command)}')" title="Executar: ${escapeHtml(snp.command)}">
              <i data-lucide="play" style="width:9px;height:9px;"></i>
              ${escapeHtml(snp.label)}
            </span>
          `).join('')}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="shortcut-top">
        <span class="shortcut-host-pill" title="${escapeHtml(host.host)}">
          ${escapeHtml(host.name)}
        </span>
        <div style="display:flex;align-items:center;gap:4px;">
          <button class="btn-del-shortcut" onclick="openEditShortcutModal('${sc.id}')" title="Editar Atalho">
            <i data-lucide="edit-2" style="width:12px;height:12px;"></i>
          </button>
          <button class="btn-del-shortcut" onclick="deleteShortcut('${sc.id}')" title="Excluir Atalho">
            <i data-lucide="trash-2" style="width:12px;height:12px;"></i>
          </button>
        </div>
      </div>

      <div class="shortcut-name">${escapeHtml(sc.name)}</div>
      
      <div class="shortcut-path-box" title="${escapeHtml(sc.path)}">
        <i data-lucide="folder" style="color:${sc.color || '#10b981'};"></i>
        <span>${escapeHtml(sc.path)}</span>
      </div>

      ${sc.description ? `<div class="shortcut-desc">${escapeHtml(sc.description)}</div>` : ''}

      ${snippetsHtml}

      <div class="shortcut-actions">
        <button class="btn-card-action btn-action-term" onclick="openSession('${sc.hostId}', '${escapeHtml(sc.path)}', 'terminal-focus', '${sc.id}')" title="Abrir terminal já nesta pasta">
          <i data-lucide="terminal" style="width:12px;height:12px;"></i>
          <span>Terminal</span>
        </button>
        <button class="btn-card-action btn-action-sftp" onclick="openSession('${sc.hostId}', '${escapeHtml(sc.path)}', 'sftp-focus', '${sc.id}')" title="Abrir explorador de arquivos nesta pasta">
          <i data-lucide="folder-tree" style="width:12px;height:12px;"></i>
          <span>Arquivos</span>
        </button>
        <button class="btn-card-action btn-action-split" onclick="openSession('${sc.hostId}', '${escapeHtml(sc.path)}', 'split-vertical', '${sc.id}')" title="Abrir Terminal + Arquivos lado a lado">
          <i data-lucide="columns-2" style="width:12px;height:12px;"></i>
          <span>Split</span>
        </button>
      </div>
    `;

    gridEl.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

// =================== SESSÕES SSH E SISTEMA MULTI-ABAS ===================
let sessionTabs = []; // Array de abas ativas: [{ id, hostId, hostName, title, initialDir, currentSftpPath, xterm, fitAddon, searchAddon, socket, containerEl }]
let activeTabId = null;
let telemetryVisible = true;
let sessionResizeObserver = null;

function getActiveTab() {
  return sessionTabs.find(t => t.id === activeTabId) || (sessionTabs.length > 0 ? sessionTabs[0] : null);
}

function getXtermThemeObject(themeName) {
  let bg = '#070a0f';
  let cursor = '#00e5ff';

  if (themeName === 'cyberpunk') {
    bg = '#0d0b18';
    cursor = '#f43f5e';
  } else if (themeName === 'dracula') {
    bg = '#1e1f29';
    cursor = '#bd93f9';
  } else if (themeName === 'nordic') {
    bg = '#181e28';
    cursor = '#88c0d0';
  }

  return {
    background: bg,
    foreground: '#e6edf3',
    cursor: cursor,
    black: '#1f242c',
    red: '#ff5c57',
    green: '#5af78e',
    yellow: '#f3f99d',
    blue: '#57c7ff',
    magenta: '#ff6ac1',
    cyan: '#9aedfe',
    white: '#f1f1f0'
  };
}

async function openSession(hostId, targetPath = '/root', preferredLayout = 'split-vertical', shortcutId = null) {
  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    showToast('Servidor não encontrado', 'error');
    return;
  }

  showToast(`Conectando com alta performance a ${host.name}...`, 'info');

  const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  const countSameHost = sessionTabs.filter(t => t.hostId === hostId).length + 1;
  const tabTitle = `${host.name} #${countSameHost}`;

  // Cria elemento container dedicado no DOM para este xterm
  const mainContainer = document.getElementById('xtermContainer');
  const tabContainer = document.createElement('div');
  tabContainer.className = 'tab-xterm-instance';
  tabContainer.id = `xterm_instance_${tabId}`;
  mainContainer.appendChild(tabContainer);

  // Instancia terminal xterm
  const xterm = new Terminal({
    theme: getXtermThemeObject(userSettings.theme || 'obsidian'),
    fontSize: 13,
    fontFamily: "'Fira Code', 'Courier New', monospace",
    cursorBlink: true,
    cursorStyle: 'bar',
    convertEol: true
  });

  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);

  let search = null;
  if (window.SearchAddon) {
    search = new SearchAddon.SearchAddon();
    xterm.loadAddon(search);
  }

  if (window.WebLinksAddon) {
    xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  xterm.open(tabContainer);

  // Conexão WebSocket com o PTY SSH remoto
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
  const socket = new WebSocket(wsUrl);

  const newTab = {
    id: tabId,
    hostId: host.id,
    hostName: host.name,
    title: tabTitle,
    initialDir: targetPath || '/root',
    currentSftpPath: targetPath || '/root',
    shortcutId: shortcutId,
    xterm: xterm,
    fitAddon: fit,
    searchAddon: search,
    socket: socket,
    containerEl: tabContainer
  };

  sessionTabs.push(newTab);
  activeSession = {
    hostId: host.id,
    hostName: host.name,
    targetPath: targetPath || '/root',
    shortcutId: shortcutId
  };

  // Teclado PRO: atalhos de cópia/colagem/busca
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown') {
      if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        const selection = xterm.getSelection();
        if (selection && selection.length > 0) {
          navigator.clipboard.writeText(selection);
          showToast('Texto copiado!', 'info');
          return false;
        }
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        pasteToTerminal();
        return false;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        toggleTermSearch();
        return false;
      }
    }
    return true;
  });

  // TECLADO EM TEMPO REAL: envia caracteres digitados diretamente ao shell PTY!
  xterm.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  xterm.onResize(({ cols, rows }) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  socket.onopen = () => {
    try { fit.fit(); } catch(e) {}
    socket.send(JSON.stringify({
      type: 'init',
      hostId: host.id,
      initialDir: targetPath || '/root',
      cols: xterm.cols || 80,
      rows: xterm.rows || 24
    }));
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' || msg.type === 'status') {
        xterm.write(msg.data);
      } else if (msg.type === 'error') {
        xterm.writeln(`\r\n\x1b[31m[FYXXSSH Erro] ${msg.message || msg.data}\x1b[0m\r\n`);
      }
    } catch (e) {
      xterm.write(event.data);
    }
  };

  socket.onclose = () => {
    xterm.writeln('\r\n\x1b[33m[Conexão finalizada pelo servidor]\x1b[0m\r\n');
  };

  // Ativa a nova aba
  switchSessionTab(tabId);

  // Configura a visualização
  currentSftpPath = targetPath || '/root';
  sftpHistory = [currentSftpPath];
  sftpHistoryIndex = 0;
  updateSftpNavButtons();

  document.getElementById('navSessionBtn').style.display = 'flex';
  document.getElementById('globalStatusText').textContent = `Conectado: ${host.name}`;
  document.getElementById('globalStatusTag').classList.add('online');

  renderSessionSnippets(shortcutId);
  setSessionLayout(preferredLayout || userSettings.layout || 'split-vertical', false);
  switchMainView('session');

  // Carrega SFTP
  loadSftpDirectory(hostId, targetPath, false);

  // Telemetria e ResizeObserver
  startTelemetryTimer();
  setupTerminalResizeObserver();
}

function openNewSessionTab() {
  const current = getActiveTab();
  if (current) {
    openSession(current.hostId, current.currentSftpPath || current.initialDir || '/root', userSettings.layout || 'split-vertical');
  } else if (hosts.length > 0) {
    openSession(hosts[0].id, '/root', userSettings.layout || 'split-vertical');
  } else {
    showToast('Cadastre um servidor SSH primeiro', 'info');
  }
}

function switchSessionTab(tabId) {
  const targetTab = sessionTabs.find(t => t.id === tabId);
  if (!targetTab) return;

  activeTabId = tabId;
  activeSession = {
    hostId: targetTab.hostId,
    hostName: targetTab.hostName,
    targetPath: targetTab.currentSftpPath || targetTab.initialDir || '/root',
    shortcutId: targetTab.shortcutId
  };

  // Mostra apenas a aba ativa
  sessionTabs.forEach(t => {
    if (t.id === tabId) {
      t.containerEl.classList.remove('hidden');
    } else {
      t.containerEl.classList.add('hidden');
    }
  });

  renderSessionTabsList();

  // Atualiza cabeçalhos
  document.getElementById('sessionHostTitle').textContent = targetTab.hostName;
  document.getElementById('sessionPathBadge').textContent = targetTab.currentSftpPath || '/root';
  document.getElementById('globalStatusText').textContent = `Conectado: ${targetTab.hostName}`;

  // Atualiza SFTP view
  currentSftpPath = targetTab.currentSftpPath || '/root';
  loadSftpDirectory(targetTab.hostId, currentSftpPath, false);

  // Redimensionamento e foco imediato no terminal
  setTimeout(() => {
    try {
      targetTab.fitAddon.fit();
      if (targetTab.socket && targetTab.socket.readyState === WebSocket.OPEN) {
        targetTab.socket.send(JSON.stringify({
          type: 'resize',
          cols: targetTab.xterm.cols,
          rows: targetTab.xterm.rows
        }));
      }
    } catch(e) {}
    targetTab.xterm.focus();
  }, 40);
}

function renderSessionTabsList() {
  const listEl = document.getElementById('sessionTabsList');
  if (!listEl) return;
  listEl.innerHTML = '';

  sessionTabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = `session-tab-item ${tab.id === activeTabId ? 'active' : ''}`;
    item.onclick = (e) => {
      if (e.target.closest('.session-tab-close')) return;
      switchSessionTab(tab.id);
    };

    item.innerHTML = `
      <span class="session-tab-dot"></span>
      <span class="session-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
      <span class="session-tab-close" onclick="closeActiveTab('${tab.id}', event)" title="Fechar Aba">&times;</span>
    `;

    listEl.appendChild(item);
  });
}

function closeActiveTab(tabIdToClose = null, event = null) {
  if (event) event.stopPropagation();

  const id = tabIdToClose || activeTabId;
  const tabIndex = sessionTabs.findIndex(t => t.id === id);
  if (tabIndex === -1) return;

  const tab = sessionTabs[tabIndex];

  try {
    if (tab.socket) tab.socket.close();
    if (tab.xterm) tab.xterm.dispose();
    if (tab.containerEl) tab.containerEl.remove();
  } catch(e) {}

  sessionTabs.splice(tabIndex, 1);

  if (sessionTabs.length > 0) {
    const nextTab = sessionTabs[Math.max(0, tabIndex - 1)];
    switchSessionTab(nextTab.id);
  } else {
    closeActiveSession();
  }
}

function closeActiveSession() {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }

  sessionTabs.forEach(tab => {
    try {
      if (tab.socket) tab.socket.close();
      if (tab.xterm) tab.xterm.dispose();
      if (tab.containerEl) tab.containerEl.remove();
    } catch(e) {}
  });

  sessionTabs = [];
  activeTabId = null;

  document.getElementById('navSessionBtn').style.display = 'none';
  document.getElementById('globalStatusText').textContent = 'Desconectado';
  document.getElementById('globalStatusTag').classList.remove('online');
  switchMainView('home');
  showToast('Sessão encerrada.', 'info');
}

function setupTerminalResizeObserver() {
  const container = document.getElementById('xtermContainer');
  if (!container || sessionResizeObserver) return;

  sessionResizeObserver = new ResizeObserver(() => {
    handleWindowResize();
  });
  sessionResizeObserver.observe(container);
}

function handleWindowResize() {
  const tab = getActiveTab();
  if (tab && tab.fitAddon) {
    try {
      tab.fitAddon.fit();
      if (tab.xterm && tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({
          type: 'resize',
          cols: tab.xterm.cols,
          rows: tab.xterm.rows
        }));
      }
    } catch(e) {}
  }
}

// =================== TELEMETRIA DISCRETA & REVELAR SENHA ===================
function toggleTelemetryVisibility() {
  const bar = document.getElementById('vpsTelemetryBar');
  const btn = document.getElementById('btnTelemetryToggle');
  if (!bar) return;

  telemetryVisible = !telemetryVisible;
  if (telemetryVisible) {
    bar.classList.remove('hidden');
    if (btn) btn.classList.add('active');
  } else {
    bar.classList.add('hidden');
    if (btn) btn.classList.remove('active');
  }
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = '<i data-lucide="eye-off"></i>';
    btn.title = 'Ocultar Senha';
  } else {
    input.type = 'password';
    btn.innerHTML = '<i data-lucide="eye"></i>';
    btn.title = 'Revelar Senha';
  }
  if (window.lucide) lucide.createIcons();
}

function openSessionAndRunSnippet(hostId, path, command) {
  openSession(hostId, path, 'terminal-focus').then(() => {
    setTimeout(() => {
      const tab = getActiveTab();
      if (tab && tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({ type: 'input', data: command + '\n' }));
      }
    }, 1200);
  });
}

function renderSessionSnippets(shortcutId) {
  const bar = document.getElementById('sessionSnippetsBar');
  const container = document.getElementById('sessionSnippetsList');
  container.innerHTML = '';

  if (!shortcutId) {
    bar.style.display = 'none';
    return;
  }

  const sc = shortcuts.find(s => s.id === shortcutId);
  if (!sc || !sc.snippets || sc.snippets.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  sc.snippets.forEach(snp => {
    const chip = document.createElement('span');
    chip.className = 'snippet-chip';
    chip.innerHTML = `<i data-lucide="play"></i> <span>${escapeHtml(snp.label)}</span>`;
    chip.onclick = () => {
      const tab = getActiveTab();
      if (tab && tab.socket && tab.socket.readyState === WebSocket.OPEN) {
        tab.socket.send(JSON.stringify({ type: 'input', data: snp.command + '\n' }));
        showToast(`Executado: ${snp.label}`, 'success');
      }
    };
    container.appendChild(chip);
  });

  if (window.lucide) lucide.createIcons();
}

// =================== CLIPBOARD & TERMINAL CONTEXT MENU ===================
async function pasteToTerminal() {
  try {
    const text = await navigator.clipboard.readText();
    const tab = getActiveTab();
    if (text && tab && tab.socket && tab.socket.readyState === WebSocket.OPEN) {
      tab.socket.send(JSON.stringify({ type: 'input', data: text }));
    }
  } catch (err) {
    showToast('Erro ao acessar área de transferência: ' + err.message, 'error');
  }
}

function clearActiveTerminal() {
  const tab = getActiveTab();
  if (tab && tab.xterm) {
    tab.xterm.clear();
    if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
      tab.socket.send(JSON.stringify({ type: 'input', data: 'clear\n' }));
    }
  }
}

function copyTerminalSelection() {
  const tab = getActiveTab();
  if (!tab || !tab.xterm) return;
  const selection = tab.xterm.getSelection();
  if (selection) {
    navigator.clipboard.writeText(selection);
    showToast('Texto copiado!', 'info');
  }
  closeTerminalContextMenu();
}

function selectAllTerminal() {
  const tab = getActiveTab();
  if (!tab || !tab.xterm) return;
  tab.xterm.selectAll();
  closeTerminalContextMenu();
}

function clearActiveTerminal() {
  if (xtermInstance) {
    xtermInstance.clear();
  }
  closeTerminalContextMenu();
}

function handleTerminalContextMenu(e) {
  e.preventDefault();
  closeSftpContextMenu();
  const menu = document.getElementById('terminalContextMenu');
  menu.style.display = 'block';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 200)}px`;
}

function closeTerminalContextMenu() {
  const menu = document.getElementById('terminalContextMenu');
  if (menu) menu.style.display = 'none';
}

function toggleTermSearch() {
  const box = document.getElementById('terminalSearchBox');
  const input = document.getElementById('termSearchInput');
  if (box.style.display === 'none') {
    box.style.display = 'flex';
    input.focus();
  } else {
    closeTermSearch();
  }
}

function closeTermSearch() {
  const box = document.getElementById('terminalSearchBox');
  if (box) box.style.display = 'none';
  const tab = getActiveTab();
  if (tab && tab.searchAddon) tab.searchAddon.clearDecorations();
}

function handleTermSearch(e) {
  if (e.key === 'Enter') {
    searchTerminalNext();
  } else if (e.key === 'Escape') {
    closeTermSearch();
  }
}

function searchTerminalNext() {
  const val = document.getElementById('termSearchInput').value;
  const tab = getActiveTab();
  if (tab && tab.searchAddon && val) {
    tab.searchAddon.findNext(val);
  }
}

// =================== TELEMETRIA VPS DISCRETA ===================
function startTelemetryTimer() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  fetchVpsStats();
  telemetryTimer = setInterval(fetchVpsStats, 12000);
}

async function fetchVpsStats() {
  const tab = getActiveTab();
  if (!tab) return;
  try {
    const res = await fetch('/api/vps-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: tab.hostId })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !data.stats) return;
    
    const stats = data.stats;
    const cpuEl = document.getElementById('statCpu');
    const ramEl = document.getElementById('statRam');
    const diskEl = document.getElementById('statDisk');
    const uptimeEl = document.getElementById('statUptime');

    if (cpuEl) cpuEl.textContent = stats.cpu || '--%';
    if (ramEl) ramEl.textContent = stats.ram || '--/--';
    if (diskEl) diskEl.textContent = stats.disk || '--';
    if (uptimeEl) uptimeEl.textContent = stats.uptime || '--';
  } catch (err) {}
}

// =================== SFTP PRO: NAVEGAÇÃO, HISTÓRICO & BREADCRUMBS ===================
async function loadSftpDirectory(hostId, remotePath, pushToHistory = true) {
  try {
    const res = await fetch('/api/sftp/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId, remotePath })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentSftpPath = data.path;
    currentSftpItems = data.items || [];
    
    // Atualiza histórico se for uma nova navegação manual
    if (pushToHistory) {
      if (sftpHistory[sftpHistoryIndex] !== currentSftpPath) {
        sftpHistory = sftpHistory.slice(0, sftpHistoryIndex + 1);
        sftpHistory.push(currentSftpPath);
        sftpHistoryIndex = sftpHistory.length - 1;
      }
    }
    updateSftpNavButtons();

    document.getElementById('sessionPathBadge').textContent = currentSftpPath;
    renderBreadcrumbs(currentSftpPath);
    renderSftpFiles(currentSftpItems);
  } catch (err) {
    showToast('Falha no SFTP: ' + err.message, 'error');
  }
}

function sftpNavigateBack() {
  if (!activeSession || sftpHistoryIndex <= 0) return;
  sftpHistoryIndex--;
  const target = sftpHistory[sftpHistoryIndex];
  loadSftpDirectory(activeSession.hostId, target, false);
}

function sftpNavigateForward() {
  if (!activeSession || sftpHistoryIndex >= sftpHistory.length - 1) return;
  sftpHistoryIndex++;
  const target = sftpHistory[sftpHistoryIndex];
  loadSftpDirectory(activeSession.hostId, target, false);
}

function updateSftpNavButtons() {
  const btnBack = document.getElementById('btnSftpBack');
  const btnForward = document.getElementById('btnSftpForward');
  if (btnBack) {
    btnBack.classList.toggle('disabled', sftpHistoryIndex <= 0);
  }
  if (btnForward) {
    btnForward.classList.toggle('disabled', sftpHistoryIndex >= sftpHistory.length - 1);
  }
}

function goToParentDirectory() {
  if (!currentSftpPath || currentSftpPath === '/') return;
  const parts = currentSftpPath.split('/').filter(p => p.length > 0);
  parts.pop();
  const parentPath = '/' + parts.join('/');
  loadSftpDirectory(activeSession.hostId, parentPath || '/');
}

function refreshSftpList() {
  if (activeSession) {
    loadSftpDirectory(activeSession.hostId, currentSftpPath, false);
  }
}

// BREADCRUMBS & ENTRADA DIRETA DE CAMINHO
function renderBreadcrumbs(fullPath) {
  const container = document.getElementById('sftpBreadcrumbs');
  if (!container) return;
  container.innerHTML = '';

  const parts = fullPath.split('/').filter(p => p.length > 0);
  
  const rootItem = document.createElement('span');
  rootItem.className = 'breadcrumb-item';
  rootItem.textContent = '/';
  rootItem.onclick = (e) => {
    e.stopPropagation();
    loadSftpDirectory(activeSession.hostId, '/');
  };
  container.appendChild(rootItem);

  let accumulated = '';
  parts.forEach((part) => {
    accumulated += '/' + part;
    const currentTarget = accumulated;

    const sep = document.createElement('span');
    sep.style.color = 'var(--text-muted)';
    sep.style.padding = '0 3px';
    sep.textContent = '>';
    container.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item';
    crumb.textContent = part;
    crumb.onclick = (e) => {
      e.stopPropagation();
      loadSftpDirectory(activeSession.hostId, currentTarget);
    };
    container.appendChild(crumb);
  });
}

function enableDirectPathInput() {
  const breadcrumbs = document.getElementById('sftpBreadcrumbs');
  const input = document.getElementById('sftpDirectPathInput');
  const pathBar = document.getElementById('sftpPathBarContainer');

  if (!input) return;
  breadcrumbs.style.display = 'none';
  input.style.display = 'block';
  input.value = currentSftpPath;
  pathBar.classList.add('editing');
  input.focus();
  input.select();
}

function disableDirectPathInput() {
  const breadcrumbs = document.getElementById('sftpBreadcrumbs');
  const input = document.getElementById('sftpDirectPathInput');
  const pathBar = document.getElementById('sftpPathBarContainer');

  if (!input) return;
  breadcrumbs.style.display = 'flex';
  input.style.display = 'none';
  pathBar.classList.remove('editing');
}

function handleDirectPathKey(e) {
  if (e.key === 'Enter') {
    const newPath = document.getElementById('sftpDirectPathInput').value.trim();
    if (newPath && activeSession) {
      loadSftpDirectory(activeSession.hostId, newPath);
    }
    disableDirectPathInput();
  } else if (e.key === 'Escape') {
    disableDirectPathInput();
  }
}

// =================== MAPEAMENTO DE ÍCONES RICOS POR TIPO DE ARQUIVO ===================
function getFileIconData(name, isDirectory) {
  if (isDirectory) {
    return {
      icon: 'folder',
      badgeClass: 'file-badge-folder',
      label: 'DIR'
    };
  }

  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';

  // Compactados (Zip, Tar, Gz, Rar, etc.)
  if (['zip', 'rar', 'tar', 'gz', 'tgz', '7z', 'bz2', 'xz'].includes(ext)) {
    return { icon: 'archive', badgeClass: 'file-badge-zip', label: ext.toUpperCase() };
  }

  // Scripts / Executáveis
  if (['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'bin', 'run'].includes(ext)) {
    return { icon: 'terminal', badgeClass: 'file-badge-sh', label: ext.toUpperCase() };
  }

  // Ambientes e Configurações (.env, yaml, toml, etc.)
  if (lower === '.env' || lower.startsWith('.env.') || ['env', 'conf', 'config', 'ini', 'toml', 'yaml', 'yml'].includes(ext)) {
    return { icon: 'sliders', badgeClass: 'file-badge-env', label: 'CFG' };
  }

  // Git (.gitignore, etc.)
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules' || ext === 'git') {
    return { icon: 'git-branch', badgeClass: 'file-badge-git', label: 'GIT' };
  }

  // JSON
  if (['json', 'jsonc'].includes(ext)) {
    return { icon: 'braces', badgeClass: 'file-badge-json', label: 'JSON' };
  }

  // JavaScript / TypeScript
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) {
    return { icon: 'file-code', badgeClass: 'file-badge-code-js', label: 'JS' };
  }
  if (['ts', 'tsx'].includes(ext)) {
    return { icon: 'file-code', badgeClass: 'file-badge-code-ts', label: 'TS' };
  }

  // Documentos e Texto
  if (['md', 'markdown', 'txt', 'log', 'pdf', 'doc', 'docx'].includes(ext)) {
    return { icon: 'file-text', badgeClass: 'file-badge-doc', label: ext.toUpperCase() };
  }

  // Imagens
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return { icon: 'image', badgeClass: 'file-badge-img', label: ext.toUpperCase() };
  }

  // Banco de Dados
  if (['sql', 'sqlite', 'db', 'dump'].includes(ext)) {
    return { icon: 'database', badgeClass: 'file-badge-db', label: 'DB' };
  }

  // Padrão
  return { icon: 'file', badgeClass: 'file-badge-default', label: ext.toUpperCase() || 'FILE' };
}

// =================== RENDERIZAÇÃO DA TABELA SFTP ===================
function renderSftpFiles(items) {
  const tbody = document.getElementById('sftpFileList');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:28px;color:var(--text-muted);font-size:12px;">Diretório vazio</td></tr>`;
    return;
  }

  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = 'sftp-row';
    tr.draggable = !item.isDirectory; // Arquivos podem ser arrastados para fora

    const itemFullPath = currentSftpPath.endsWith('/') 
      ? currentSftpPath + item.name 
      : currentSftpPath + '/' + item.name;

    item.fullPath = itemFullPath;
    const iconData = getFileIconData(item.name, item.isDirectory);

    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <div class="file-icon-badge ${iconData.badgeClass}">
            <i data-lucide="${iconData.icon}"></i>
          </div>
          <span class="file-name-text">${escapeHtml(item.name)}</span>
        </div>
      </td>
      <td class="mono">${item.isDirectory ? '-' : formatBytes(item.size)}</td>
      <td style="font-size:10px;color:var(--text-muted);">${formatDate(item.mtime)}</td>
      <td>
        <div class="file-actions-cell">
          ${item.isDirectory 
            ? `<button class="row-action-btn" title="Abrir pasta" onclick="loadSftpDirectory('${activeSession.hostId}', '${escapeHtml(itemFullPath)}')"><i data-lucide="chevron-right"></i></button>` 
            : `
              <button class="row-action-btn edit" title="Editar arquivo" onclick="openFileEditor('${escapeHtml(itemFullPath)}')"><i data-lucide="edit-3"></i></button>
              <button class="row-action-btn" title="Baixar" onclick="downloadFile('${escapeHtml(itemFullPath)}')"><i data-lucide="download"></i></button>
            `
          }
          <button class="row-action-btn del" title="Excluir" onclick="deleteSftpItem('${escapeHtml(itemFullPath)}', ${item.isDirectory})"><i data-lucide="trash"></i></button>
        </div>
      </td>
    `;

    // Clique duplo para abrir ou editar
    if (item.isDirectory) {
      tr.ondblclick = () => loadSftpDirectory(activeSession.hostId, itemFullPath);
    } else {
      tr.ondblclick = () => openFileEditor(itemFullPath);
    }

    // Clique com botão direito -> Menu de Contexto rico
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      openSftpContextMenu(e, item);
    };

    // Arrastar para o Windows (Drag-Out)
    if (!item.isDirectory) {
      tr.ondragstart = (e) => handleSftpItemDragStart(e, item);
    }

    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// =================== ARRASTAR DO SERVIDOR PARA O WINDOWS (DRAG-OUT) ===================
async function handleSftpItemDragStart(e, item) {
  if (!window.electronAPI || !window.electronAPI.startDrag) return;

  // Prepara o arquivo no backend fazendo download para a pasta temporária do Windows
  try {
    const res = await fetch('/api/sftp/prepare-drag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, remotePath: item.fullPath })
    });
    const data = await res.json();
    if (data.success && data.localPath) {
      window.electronAPI.startDrag(data.localPath);
    }
  } catch (err) {
    console.warn('Erro ao preparar drag-out:', err);
  }
}

// =================== MENU DE CONTEXTO DO SFTP ===================
function openSftpContextMenu(e, item) {
  activeContextItem = item;
  closeTerminalContextMenu();

  const menu = document.getElementById('sftpContextMenu');
  const itemNameEl = document.getElementById('sftpCtxItemName');
  const fileActions = document.getElementById('sftpCtxFileActions');
  const folderActions = document.getElementById('sftpCtxFolderActions');

  if (itemNameEl) itemNameEl.textContent = item.name;

  if (item.isDirectory) {
    fileActions.style.display = 'none';
    folderActions.style.display = 'block';
  } else {
    fileActions.style.display = 'block';
    folderActions.style.display = 'none';
  }

  menu.style.display = 'block';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 300)}px`;
}

function closeSftpContextMenu() {
  const menu = document.getElementById('sftpContextMenu');
  if (menu) menu.style.display = 'none';
}

function handleSftpCtxEdit() {
  closeSftpContextMenu();
  if (activeContextItem && !activeContextItem.isDirectory) {
    openFileEditor(activeContextItem.fullPath);
  }
}

function handleSftpCtxDownload() {
  closeSftpContextMenu();
  if (activeContextItem && !activeContextItem.isDirectory) {
    downloadFile(activeContextItem.fullPath);
  }
}

async function handleSftpCtxDuplicate() {
  closeSftpContextMenu();
  if (!activeContextItem || activeContextItem.isDirectory) return;

  showToast(`Duplicando ${activeContextItem.name}...`, 'info');
  try {
    const res = await fetch('/api/sftp/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, filePath: activeContextItem.fullPath })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('Arquivo duplicado com sucesso!', 'success');
    refreshSftpList();
  } catch (err) {
    showToast('Erro ao duplicar: ' + err.message, 'error');
  }
}

function handleSftpCtxOpenFolder() {
  closeSftpContextMenu();
  if (activeContextItem && activeContextItem.isDirectory) {
    loadSftpDirectory(activeSession.hostId, activeContextItem.fullPath);
  }
}

function handleSftpCtxCdTerminal() {
  closeSftpContextMenu();
  if (!activeContextItem) return;
  const targetDir = activeContextItem.isDirectory ? activeContextItem.fullPath : currentSftpPath;
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: 'input', data: `cd "${targetDir}"\n` }));
    showToast(`Navegado no terminal: cd "${targetDir}"`, 'info');
  }
}

function handleSftpCtxPinShortcut() {
  closeSftpContextMenu();
  if (!activeContextItem) return;
  const targetDir = activeContextItem.isDirectory ? activeContextItem.fullPath : currentSftpPath;
  openShortcutModal();
  document.getElementById('scHostSelect').value = activeSession.hostId;
  document.getElementById('scPath').value = targetDir;
  autoFillShortcutNameFromPath(targetDir);
}

function handleSftpCtxRename() {
  closeSftpContextMenu();
  if (!activeContextItem) return;
  const input = document.getElementById('renameInput');
  input.value = activeContextItem.name;
  openModal('renameModal');
  setTimeout(() => input.focus(), 100);
}

async function submitRenameItem() {
  if (!activeContextItem || !activeSession) return;
  const newName = document.getElementById('renameInput').value.trim();
  if (!newName || newName === activeContextItem.name) {
    closeModal('renameModal');
    return;
  }

  const oldPath = activeContextItem.fullPath;
  const dir = currentSftpPath.endsWith('/') ? currentSftpPath : currentSftpPath + '/';
  const newPath = dir + newName;

  try {
    const res = await fetch('/api/sftp/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, oldPath, newPath })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal('renameModal');
    showToast('Renomeado com sucesso!', 'success');
    refreshSftpList();
  } catch (err) {
    showToast('Erro ao renomear: ' + err.message, 'error');
  }
}

function handleSftpCtxCopyPath() {
  closeSftpContextMenu();
  if (activeContextItem) {
    navigator.clipboard.writeText(activeContextItem.fullPath);
    showToast('Caminho remoto copiado!', 'info');
  }
}

function handleSftpCtxChmod() {
  closeSftpContextMenu();
  if (!activeContextItem) return;
  const input = document.getElementById('chmodInput');
  input.value = activeContextItem.permissions || (activeContextItem.isDirectory ? '755' : '644');
  openModal('chmodModal');
  setTimeout(() => input.focus(), 100);
}

async function submitChmodItem() {
  if (!activeContextItem || !activeSession) return;
  const mode = document.getElementById('chmodInput').value.trim();
  if (!mode) return;

  try {
    const res = await fetch('/api/sftp/chmod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, filePath: activeContextItem.fullPath, mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal('chmodModal');
    showToast('Permissões aplicadas!', 'success');
    refreshSftpList();
  } catch (err) {
    showToast('Erro ao alterar permissões: ' + err.message, 'error');
  }
}

async function handleSftpCtxDelete() {
  closeSftpContextMenu();
  if (activeContextItem) {
    deleteSftpItem(activeContextItem.fullPath, activeContextItem.isDirectory);
  }
}

// =================== RESOLUÇÃO INTELIGENTE DE CONFLITOS DE ARQUIVOS ===================
function showConflictModal(fileName) {
  // Se o usuário já marcou "Aplicar a todos", usa a escolha memorizada
  if (batchConflictChoice) {
    return Promise.resolve(batchConflictChoice);
  }

  return new Promise((resolve) => {
    conflictResolver = resolve;
    const nameEl = document.getElementById('conflictFileName');
    const chk = document.getElementById('conflictApplyToAll');
    if (nameEl) nameEl.textContent = fileName;
    if (chk) chk.checked = false;
    openModal('fileConflictModal');
  });
}

function resolveConflict(action) {
  const chk = document.getElementById('conflictApplyToAll');
  if (chk && chk.checked && action !== 'cancel') {
    batchConflictChoice = action;
  }
  closeModal('fileConflictModal');
  if (conflictResolver) {
    conflictResolver(action);
    conflictResolver = null;
  }
}

// =================== DRAG & DROP E UPLOAD EM MASSA COM ALTA PERFORMANCE ===================
function setupDragAndDrop() {
  const dropZone = document.getElementById('sftpDropZone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', async (e) => {
    const files = e.dataTransfer.files;
    if (!files || files.length === 0 || !activeSession) return;
    await processFileUploadBatch(Array.from(files));
  }, false);
}

async function handleFileUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0 || !activeSession) return;
  await processFileUploadBatch(Array.from(files));
  e.target.value = ''; // Limpa input
}

// PROCESSAMENTO EM LOTE COM DETECÇÃO DE NOMES DUPLICADOS E VELOCIDADE MÁXIMA
async function processFileUploadBatch(files) {
  if (!activeSession || files.length === 0) return;
  batchConflictChoice = null; // Reseta regra para o novo lote

  // 1. Checa quais arquivos já existem remotamente para rapidez instantânea
  const fileNames = files.map(f => f.name);
  let existingNames = new Set();

  try {
    const res = await fetch('/api/sftp/check-exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, remotePath: currentSftpPath, filenames: fileNames })
    });
    const checkData = await res.json();
    if (checkData.existing) {
      existingNames = new Set(checkData.existing);
    }
  } catch (err) {}

  showToast(`Iniciando transferência de ${files.length} arquivo(s)...`, 'info');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let targetName = file.name;

    // Se arquivo já existe no destino
    if (existingNames.has(file.name)) {
      const decision = await showConflictModal(file.name);

      if (decision === 'cancel') {
        showToast('Transferência cancelada pelo usuário.', 'info');
        break;
      } else if (decision === 'skip') {
        continue;
      } else if (decision === 'rename') {
        // Gera nome alternativo: arquivo (1).ext
        const dotIndex = file.name.lastIndexOf('.');
        if (dotIndex > 0) {
          const base = file.name.substring(0, dotIndex);
          const ext = file.name.substring(dotIndex);
          targetName = `${base} (1)${ext}`;
        } else {
          targetName = `${file.name} (1)`;
        }
      }
    }

    await uploadSingleFile(file, targetName);
  }

  refreshSftpList();
}

async function uploadSingleFile(file, targetFilename) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('hostId', activeSession.hostId);
  formData.append('remotePath', currentSftpPath);
  if (targetFilename) {
    formData.append('targetFilename', targetFilename);
  }

  try {
    const res = await fetch('/api/sftp/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(`✔ Enviado: ${targetFilename || file.name}`, 'success');
  } catch (err) {
    showToast(`Erro ao enviar ${file.name}: ` + err.message, 'error');
  }
}

function downloadFile(filePath) {
  if (!activeSession) return;
  const url = `/api/sftp/download?hostId=${encodeURIComponent(activeSession.hostId)}&filePath=${encodeURIComponent(filePath)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filePath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function deleteSftpItem(itemPath, isDirectory) {
  const itemType = isDirectory ? 'a pasta' : 'o arquivo';
  const confirmed = await showConfirmModal({
    title: `Excluir ${isDirectory ? 'Pasta' : 'Arquivo'}`,
    message: `Tem certeza que deseja excluir permanentemente ${itemType}:\n"${itemPath}"?`,
    confirmText: 'Excluir',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await fetch('/api/sftp/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, itemPath, isDirectory })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('Item excluído com sucesso!', 'success');
    refreshSftpList();
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// =================== CRIAÇÃO DE NOVA PASTA SFTP ===================
function openNewFolderModal() {
  document.getElementById('newFolderName').value = '';
  openModal('folderModal');
  setTimeout(() => document.getElementById('newFolderName').focus(), 100);
}

async function submitCreateFolder() {
  const name = document.getElementById('newFolderName').value.trim();
  if (!name || !activeSession) return;

  const targetDir = currentSftpPath.endsWith('/') 
    ? currentSftpPath + name 
    : currentSftpPath + '/' + name;

  try {
    const res = await fetch('/api/sftp/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, dirPath: targetDir })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal('folderModal');
    showToast(`Pasta criada: ${name}`, 'success');
    refreshSftpList();
  } catch (err) {
    showToast('Erro ao criar pasta: ' + err.message, 'error');
  }
}

// =================== EDITOR DE ARQUIVOS REMOTO ===================
async function openFileEditor(filePath) {
  try {
    showToast('Carregando arquivo...', 'info');
    const res = await fetch('/api/sftp/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, filePath })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentEditingFile = filePath;
    document.getElementById('editorFilePath').textContent = filePath;
    document.getElementById('remoteFileContent').value = data.content;
    document.getElementById('editorSaveStatus').textContent = '';
    openModal('editorModal');
  } catch (err) {
    showToast('Falha ao abrir arquivo: ' + err.message, 'error');
  }
}

async function saveRemoteFile() {
  if (!currentEditingFile || !activeSession) return;
  const content = document.getElementById('remoteFileContent').value;
  const statusEl = document.getElementById('editorSaveStatus');

  statusEl.textContent = 'Salvando...';

  try {
    const res = await fetch('/api/sftp/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId, filePath: currentEditingFile, content })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    statusEl.textContent = '✔ Salvo com sucesso!';
    showToast('Arquivo salvo no servidor!', 'success');
    refreshSftpList();
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = '❌ Erro ao salvar: ' + err.message;
    showToast('Erro ao salvar: ' + err.message, 'error');
  }
}

// =================== CAPTURA INTELIGENTE DE CWD & FIXAR ATALHO ===================
async function pinCurrentPathAsShortcut() {
  if (!activeSession) return;
  
  let targetPath = currentSftpPath || '/root';

  // Tenta capturar o diretório exato de trabalho do terminal shell ativo na VPS
  try {
    const res = await fetch('/api/terminal/cwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: activeSession.hostId })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.cwd && data.cwd.trim().length > 0) {
        targetPath = data.cwd.trim();
      }
    }
  } catch (err) {
    console.warn('Não foi possível ler CWD do terminal, usando path do SFTP:', err);
  }

  // Normaliza o caminho removendo barras sobressalentes
  targetPath = targetPath.trim();
  if (targetPath.length > 1 && targetPath.endsWith('/')) {
    targetPath = targetPath.slice(0, -1);
  }

  openShortcutModal();
  document.getElementById('scHostSelect').value = activeSession.hostId;
  document.getElementById('scPath').value = targetPath;
  autoFillShortcutNameFromPath(targetPath);
}

function autoFillShortcutNameFromPath(path) {
  if (!path) return;
  const clean = path.trim().replace(/\/+$/, '');
  const parts = clean.split('/').filter(p => p.length > 0);
  const folderName = parts.length > 0 ? parts[parts.length - 1] : 'Root';
  
  const nameInput = document.getElementById('scName');
  if (nameInput) {
    nameInput.placeholder = folderName;
    if (!nameInput.value || nameInput.dataset.autoFilled === 'true') {
      nameInput.value = folderName;
      nameInput.dataset.autoFilled = 'true';
    }
  }
}

// =================== CRUD ATALHOS DE DIRETÓRIOS ===================
function openShortcutModal() {
  if (hosts.length === 0) {
    showToast('Cadastre um servidor SSH primeiro antes de criar atalhos.', 'error');
    openHostModal();
    return;
  }
  document.getElementById('scEditId').value = '';
  document.getElementById('shortcutModalTitle').textContent = 'Novo Atalho de Pasta';
  document.getElementById('btnSaveShortcutSubmit').textContent = 'Salvar Atalho';

  document.getElementById('scName').value = '';
  document.getElementById('scName').dataset.autoFilled = 'false';
  document.getElementById('scPath').value = '';
  document.getElementById('scDesc').value = '';
  document.getElementById('scSnippetsText').value = '';
  document.getElementById('scColor').value = '#10b981';

  populateHostSelects();
  openModal('shortcutModal');
}

function openEditShortcutModal(shortcutId) {
  const sc = shortcuts.find(s => s.id === shortcutId);
  if (!sc) return;

  populateHostSelects();
  document.getElementById('scEditId').value = sc.id;
  document.getElementById('shortcutModalTitle').textContent = 'Editar Atalho de Pasta';
  document.getElementById('btnSaveShortcutSubmit').textContent = 'Salvar Alterações';

  document.getElementById('scHostSelect').value = sc.hostId;
  document.getElementById('scName').value = sc.name || '';
  document.getElementById('scName').dataset.autoFilled = 'false';
  document.getElementById('scPath').value = sc.path || '';
  document.getElementById('scDesc').value = sc.description || '';
  document.getElementById('scColor').value = sc.color || '#10b981';

  let snippetsText = '';
  if (sc.snippets && sc.snippets.length > 0) {
    snippetsText = sc.snippets.map(s => `${s.label} | ${s.command}`).join('\n');
  }
  document.getElementById('scSnippetsText').value = snippetsText;

  openModal('shortcutModal');
}

async function handleSaveShortcut(e) {
  e.preventDefault();
  const editId = document.getElementById('scEditId').value;
  const hostId = document.getElementById('scHostSelect').value;
  const name = document.getElementById('scName').value;
  const path = document.getElementById('scPath').value;
  const description = document.getElementById('scDesc').value;
  const color = document.getElementById('scColor').value;
  const snippetsRaw = document.getElementById('scSnippetsText').value;

  const snippets = [];
  snippetsRaw.split('\n').forEach(line => {
    const parts = line.split('|');
    if (parts.length >= 2) {
      snippets.push({
        label: parts[0].trim(),
        command: parts.slice(1).join('|').trim()
      });
    } else if (line.trim().length > 0) {
      snippets.push({
        label: line.trim(),
        command: line.trim()
      });
    }
  });

  const payload = { hostId, name, path, description, color, snippets };

  try {
    let res;
    if (editId) {
      res = await fetch(`/api/shortcuts/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/shortcuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const savedSc = await res.json();
    if (!res.ok) throw new Error(savedSc.error);

    closeModal('shortcutModal');
    showToast(editId ? 'Atalho atualizado com sucesso!' : 'Atalho criado com sucesso!', 'success');
    await loadShortcuts();
  } catch (err) {
    showToast('Erro ao salvar atalho: ' + err.message, 'error');
  }
}

async function deleteShortcut(id) {
  const confirmed = await showConfirmModal({
    title: 'Excluir Atalho',
    message: 'Deseja realmente remover este atalho de pasta?',
    confirmText: 'Excluir Atalho',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/shortcuts/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Erro ao deletar');

    showToast('Atalho removido!', 'success');
    await loadShortcuts();
  } catch (err) {
    showToast('Erro ao remover atalho: ' + err.message, 'error');
  }
}

// =================== CRUD SERVIDORES (HOSTS) ===================
function openHostModal() {
  document.getElementById('hostEditId').value = '';
  document.getElementById('hostModalTitle').textContent = 'Cadastrar Servidor SSH';
  document.getElementById('btnSaveHostSubmit').textContent = 'Salvar Servidor';

  document.getElementById('hostName').value = '';
  document.getElementById('hostAddress').value = '';
  document.getElementById('hostPort').value = '22';
  document.getElementById('hostUser').value = 'root';
  
  const passInput = document.getElementById('hostPassword');
  if (passInput) {
    passInput.value = '';
    passInput.type = 'password';
  }
  const passBtn = document.querySelector('#authPasswordGroup .btn-toggle-password');
  if (passBtn) {
    passBtn.innerHTML = '<i data-lucide="eye"></i>';
    passBtn.title = 'Revelar Senha';
  }

  document.getElementById('hostPrivateKey').value = '';
  document.getElementById('hostColor').value = '#3b82f6';
  document.querySelector('input[name="authType"][value="password"]').checked = true;
  toggleAuthTypeUI();
  openModal('hostModal');
}

function openEditHostModal(hostId) {
  const host = hosts.find(h => h.id === hostId);
  if (!host) return;

  document.getElementById('hostEditId').value = host.id;
  document.getElementById('hostModalTitle').textContent = 'Editar Servidor SSH';
  document.getElementById('btnSaveHostSubmit').textContent = 'Salvar Alterações';

  document.getElementById('hostName').value = host.name || '';
  document.getElementById('hostAddress').value = host.host || '';
  document.getElementById('hostPort').value = host.port || '22';
  document.getElementById('hostUser').value = host.username || 'root';
  
  const passInput = document.getElementById('hostPassword');
  if (passInput) {
    passInput.value = host.password || '';
    passInput.type = 'password';
  }
  const passBtn = document.querySelector('#authPasswordGroup .btn-toggle-password');
  if (passBtn) {
    passBtn.innerHTML = '<i data-lucide="eye"></i>';
    passBtn.title = 'Revelar Senha';
  }

  document.getElementById('hostPrivateKey').value = host.privateKey || '';
  document.getElementById('hostColor').value = host.color || '#3b82f6';

  const authRadio = document.querySelector(`input[name="authType"][value="${host.authType || 'password'}"]`);
  if (authRadio) authRadio.checked = true;
  toggleAuthTypeUI();

  openModal('hostModal');
}

function toggleAuthTypeUI() {
  const isKey = document.querySelector('input[name="authType"]:checked').value === 'key';
  document.getElementById('authPasswordGroup').style.display = isKey ? 'none' : 'block';
  document.getElementById('authKeyGroup').style.display = isKey ? 'block' : 'none';
}

async function testHostConnection() {
  const host = document.getElementById('hostAddress').value.trim();
  const port = document.getElementById('hostPort').value.trim();
  const username = document.getElementById('hostUser').value.trim();
  const authType = document.querySelector('input[name="authType"]:checked').value;
  const password = document.getElementById('hostPassword').value;
  const privateKey = document.getElementById('hostPrivateKey').value;

  if (!host) {
    showToast('Informe o endereço IP ou domínio primeiro.', 'error');
    return;
  }

  showToast('Testando conexão SSH de alta velocidade...', 'info');

  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, username, authType, password, privateKey })
    });

    const data = await res.json();
    if (data.success) {
      showToast('✔ Conexão estabelecida com sucesso!', 'success');
    } else {
      showToast('❌ Falha na conexão: ' + (data.error || 'Erro desconhecido'), 'error');
    }
  } catch (err) {
    showToast('❌ Erro no teste: ' + err.message, 'error');
  }
}

async function handleSaveHost(e) {
  e.preventDefault();
  
  const submitBtn = document.getElementById('btnSaveHostSubmit');
  if (submitBtn) submitBtn.disabled = true;

  const editId = document.getElementById('hostEditId').value;
  const name = document.getElementById('hostName').value.trim();
  const host = document.getElementById('hostAddress').value.trim();
  const port = document.getElementById('hostPort').value.trim();
  const username = document.getElementById('hostUser').value.trim();
  const authType = document.querySelector('input[name="authType"]:checked').value;
  const password = document.getElementById('hostPassword').value;
  const privateKey = document.getElementById('hostPrivateKey').value;
  const color = document.getElementById('hostColor').value;

  if (!host) {
    showToast('Informe o IP ou domínio do servidor', 'error');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  const payload = { name, host, port, username, authType, password, privateKey, color };

  try {
    let res;
    if (editId) {
      res = await fetch(`/api/hosts/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    const savedHost = await res.json();
    if (!res.ok) throw new Error(savedHost.error || 'Erro ao salvar servidor');

    closeModal('hostModal');
    showToast(editId ? `Servidor "${savedHost.name}" atualizado!` : `Servidor "${savedHost.name}" salvo com sucesso!`, 'success');
    
    await loadHosts();
  } catch (err) {
    console.error('Erro ao salvar servidor:', err);
    showToast('Erro ao salvar servidor: ' + err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function deleteHost(id) {
  const confirmed = await showConfirmModal({
    title: 'Excluir Servidor',
    message: 'Deseja excluir este servidor e todos os atalhos vinculados a ele?',
    confirmText: 'Excluir Servidor',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Erro ao deletar');

    showToast('Servidor removido com sucesso!', 'success');
    await loadHosts();
    await loadShortcuts();
  } catch (err) {
    showToast('Erro ao remover: ' + err.message, 'error');
  }
}

// =================== EVENTOS GLOBAIS ===================
function setupGlobalEvents() {
  // Fecha menus de contexto ao clicar fora
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#terminalContextMenu')) {
      closeTerminalContextMenu();
    }
    if (!e.target.closest('#sftpContextMenu')) {
      closeSftpContextMenu();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTerminalContextMenu();
      closeSftpContextMenu();
      closeTermSearch();
    }
    // Atalhos do SFTP: Alt+Left (Voltar), Alt+Right (Avançar), F5 (Atualizar)
    if (activeSession && document.getElementById('sessionView').classList.contains('active')) {
      if (e.altKey && e.key === 'ArrowLeft') {
        sftpNavigateBack();
      } else if (e.altKey && e.key === 'ArrowRight') {
        sftpNavigateForward();
      } else if (e.key === 'F5') {
        e.preventDefault();
        refreshSftpList();
      }
    }
  });

  // Marca que o usuário editou o nome do atalho manualmente
  const scNameInput = document.getElementById('scName');
  if (scNameInput) {
    scNameInput.addEventListener('input', () => {
      scNameInput.dataset.autoFilled = 'false';
    });
  }
}

// =================== MODAL & HELPERS ===================
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
  if (window.lucide) lucide.createIcons();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =================== AUTO-UPDATE FYXXSSH (GITHUB) ===================
let appUpdateData = null;
let updatePollingTimer = null;

async function checkAppUpdates(silent = false) {
  try {
    if (!silent) {
      showToast('Buscando atualizações no GitHub...', 'info');
    }

    const res = await fetch('/api/updates/check');
    const data = await res.json();

    if (!data.success) {
      if (!silent) {
        showToast('Não foi possível verificar atualizações: ' + (data.error || 'Erro desconhecido'), 'error');
      }
      return;
    }

    appUpdateData = data;

    // Atualiza badges visuais se houver atualização disponível
    const pillBadge = document.getElementById('updatePillBadge');
    const pillText = document.getElementById('updatePillText');

    if (data.updateAvailable) {
      if (pillBadge) {
        pillBadge.style.display = 'inline-flex';
        if (pillText) pillText.textContent = `Nova Versão v${data.latestVersion}`;
      }

      // Popula o modal de update
      const curVerEl = document.getElementById('updateCurrentVer');
      const latVerEl = document.getElementById('updateLatestVer');
      const notesEl = document.getElementById('updateReleaseNotes');
      const subEl = document.getElementById('updateModalSubtitle');

      if (curVerEl) curVerEl.textContent = `v${data.currentVersion}`;
      if (latVerEl) latVerEl.textContent = `v${data.latestVersion}`;
      if (subEl) subEl.textContent = `A versão ${data.name || data.latestVersion} está pronta para download!`;
      if (notesEl) {
        notesEl.textContent = data.notes && data.notes.trim() ? data.notes : 'Melhorias de desempenho, velocidade na conexão SSH/SFTP e correções de estabilidade.';
      }

      if (!silent) {
        openUpdateModal();
      } else {
        showToast(`🚀 Nova versão v${data.latestVersion} do FYXXSSH disponível! Clique no topo para atualizar.`, 'info');
      }
    } else {
      if (pillBadge) {
        pillBadge.style.display = 'none';
      }
      if (!silent) {
        showToast(`Você já está na versão mais recente do FYXXSSH (v${data.currentVersion})!`, 'success');
      }
    }
  } catch (err) {
    if (!silent) {
      showToast('Erro ao consultar atualizações: ' + err.message, 'error');
    }
  }
}

function openUpdateModal() {
  openModal('updateModal');
  if (window.lucide) lucide.createIcons();
}

async function handleUpdateActionClick() {
  const btn = document.getElementById('btnUpdateAction');
  const btnText = document.getElementById('btnUpdateActionText');
  const downloadSection = document.getElementById('updateDownloadSection');
  const statusText = document.getElementById('updateDownloadStatusText');
  const percentText = document.getElementById('updateDownloadPercent');
  const progressBar = document.getElementById('updateProgressBar');
  const bytesInfo = document.getElementById('updateDownloadBytes');

  // Caso 1: Se já terminou o download, clica para instalar e reiniciar
  if (btn && btn.dataset.readyToInstall === 'true') {
    btn.disabled = true;
    btnText.textContent = 'Iniciando instalador...';
    showToast('Executando instalador... O FYXXSSH será fechado agora.', 'info');

    try {
      const res = await fetch('/api/updates/install', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        showToast('Erro ao iniciar instalador: ' + data.error, 'error');
        btn.disabled = false;
      }
    } catch (e) {
      showToast('Instalador acionado com sucesso. Fechando aplicativo...', 'info');
    }
    return;
  }

  // Caso 2: Iniciar o download
  if (downloadSection) downloadSection.style.display = 'flex';
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Baixando...';

  try {
    const res = await fetch('/api/updates/download', { method: 'POST' });
    const data = await res.json();

    if (!data.success) {
      showToast('Falha ao iniciar download: ' + data.error, 'error');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Tentar Novamente';
      return;
    }

    // Inicia polling de progresso a cada 350ms
    if (updatePollingTimer) clearInterval(updatePollingTimer);
    updatePollingTimer = setInterval(async () => {
      try {
        const progRes = await fetch('/api/updates/progress');
        const prog = await progRes.json();

        if (progressBar) progressBar.style.width = `${prog.progress || 0}%`;
        if (percentText) percentText.textContent = `${prog.progress || 0}%`;
        if (bytesInfo) {
          bytesInfo.textContent = `${formatBytes(prog.transferredBytes || 0)} / ${formatBytes(prog.totalBytes || 0)}`;
        }

        if (prog.status === 'ready') {
          clearInterval(updatePollingTimer);
          updatePollingTimer = null;
          if (statusText) statusText.textContent = 'Download concluído com sucesso!';
          if (btn) {
            btn.disabled = false;
            btn.dataset.readyToInstall = 'true';
            btn.classList.add('ready-to-install');
          }
          if (btnText) btnText.textContent = 'Reiniciar e Atualizar Agora';
          showToast('Download concluído! Clique em "Reiniciar e Atualizar Agora" para aplicar.', 'success');
        } else if (prog.status === 'error') {
          clearInterval(updatePollingTimer);
          updatePollingTimer = null;
          if (statusText) statusText.textContent = 'Falha no download: ' + (prog.errorMessage || 'Erro de conexão');
          if (btn) {
            btn.disabled = false;
            btn.dataset.readyToInstall = 'false';
          }
          if (btnText) btnText.textContent = 'Tentar Novamente';
          showToast('Erro no download da atualização.', 'error');
        }
      } catch (e) {
        console.warn('Erro ao consultar progresso de update:', e);
      }
    }, 350);
  } catch (err) {
    showToast('Erro ao baixar atualização: ' + err.message, 'error');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Atualizar Agora';
  }
}
