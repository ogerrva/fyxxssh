const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

const PORT = process.env.PORT || 4321;

// Diretório de dados permanente no Windows (%APPDATA%\FYXXSSH)
const USER_DATA_DIR = process.env.APPDATA 
  ? path.join(process.env.APPDATA, 'FYXXSSH')
  : path.join(__dirname, 'data');

if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

const DATA_FILE = path.join(USER_DATA_DIR, 'storage.json');
const UPLOADS_DIR = path.join(USER_DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Inicialização e Leitura do Storage
function loadStorage() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const initialData = {
        hosts: [],
        shortcuts: [],
        settings: {
          theme: 'obsidian',
          layout: 'split-vertical',
          rightClickAction: 'menu'
        }
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
      return initialData;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.hosts) parsed.hosts = [];
    if (!parsed.shortcuts) parsed.shortcuts = [];
    if (!parsed.settings) {
      parsed.settings = { theme: 'obsidian', layout: 'split-vertical', rightClickAction: 'menu' };
    }
    return parsed;
  } catch (err) {
    console.error('Erro ao ler storage:', err);
    return { hosts: [], shortcuts: [], settings: { theme: 'obsidian', layout: 'split-vertical' } };
  }
}

function saveStorage(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('ERRO CRÍTICO AO SALVAR STORAGE:', err);
    return false;
  }
}

// Diretório permanente para downloads de atualizações
const UPDATES_DIR = path.join(USER_DATA_DIR, 'updates');
if (!fs.existsSync(UPDATES_DIR)) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
}

// Helpers SSH com compatibilidade universal e alta velocidade
function getSSHConfig(host) {
  const config = {
    host: host.host,
    port: parseInt(host.port, 10) || 22,
    username: host.username || 'root',
    readyTimeout: 30000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 5
  };

  if (host.authType === 'key' && host.privateKey) {
    config.privateKey = host.privateKey;
    if (host.passphrase) config.passphrase = host.passphrase;
  } else {
    config.password = host.password || '';
  }

  return config;
}

// =================== SISTEMA DE ATUALIZAÇÃO AUTOMÁTICA (GITHUB) ===================
const APP_PACKAGE = require('./package.json');
const CURRENT_VERSION = APP_PACKAGE.version || '1.0.0';
const GITHUB_REPO = 'ogerrva/fyxxssh';

let updateState = {
  status: 'idle', // 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  progress: 0,
  totalBytes: 0,
  transferredBytes: 0,
  latestVersion: null,
  currentVersion: CURRENT_VERSION,
  releaseName: '',
  releaseNotes: '',
  downloadUrl: null,
  assetName: null,
  localInstallerPath: null,
  errorMessage: null
};

function parseVersionNumbers(v) {
  return (v || '').replace(/^[^\d]*/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function compareSemVer(vLatest, vCurrent) {
  const p1 = parseVersionNumbers(vLatest);
  const p2 = parseVersionNumbers(vCurrent);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function fetchGithubJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'FYXXSSH-App/' + CURRENT_VERSION,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Erro ao interpretar JSON do GitHub'));
          }
        } else {
          reject(new Error(`GitHub retornou status ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

function downloadFileWithRedirects(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function startGet(currentUrl, redirectCount = 0) {
      if (redirectCount > 8) {
        return reject(new Error('Muitos redirecionamentos'));
      }
      const client = currentUrl.startsWith('https:') ? https : http;
      client.get(currentUrl, { headers: { 'User-Agent': 'FYXXSSH-App/' + CURRENT_VERSION } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return startGet(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Falha no download (HTTP ${res.statusCode})`));
        }

        const total = parseInt(res.headers['content-length'] || 0, 10);
        let transferred = 0;
        const out = fs.createWriteStream(destPath);

        res.on('data', chunk => {
          transferred += chunk.length;
          if (onProgress) onProgress(transferred, total);
        });

        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve({ destPath, total }));
        });
        out.on('error', err => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    startGet(url);
  });
}

// ROTA 1: Verificar se há nova versão no GitHub
app.get('/api/updates/check', async (req, res) => {
  try {
    const release = await fetchGithubJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const remoteTag = release.tag_name || '';
    const cleanRemoteVer = remoteTag.replace(/^v/, '');
    const hasUpdate = compareSemVer(cleanRemoteVer, CURRENT_VERSION) > 0;

    // Localizar o executável do instalador nos assets
    let exeAsset = null;
    if (Array.isArray(release.assets)) {
      exeAsset = release.assets.find(a => a.name.toLowerCase().endsWith('.exe')) || release.assets[0];
    }

    updateState.latestVersion = cleanRemoteVer;
    updateState.currentVersion = CURRENT_VERSION;
    updateState.releaseName = release.name || remoteTag;
    updateState.releaseNotes = release.body || '';
    updateState.downloadUrl = exeAsset ? exeAsset.browser_download_url : null;
    updateState.assetName = exeAsset ? exeAsset.name : null;
    updateState.totalBytes = exeAsset ? exeAsset.size : 0;

    res.json({
      success: true,
      updateAvailable: hasUpdate,
      currentVersion: CURRENT_VERSION,
      latestVersion: cleanRemoteVer,
      tag: remoteTag,
      name: release.name || remoteTag,
      notes: release.body || '',
      downloadUrl: updateState.downloadUrl,
      assetName: updateState.assetName,
      assetSize: updateState.totalBytes,
      publishedAt: release.published_at
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      updateAvailable: false,
      currentVersion: CURRENT_VERSION,
      error: err.message
    });
  }
});

// ROTA 2: Obter status/progresso atual do update
app.get('/api/updates/progress', (req, res) => {
  res.json(updateState);
});

// ROTA 3: Iniciar o download da nova versão
app.post('/api/updates/download', async (req, res) => {
  if (updateState.status === 'downloading') {
    return res.json({ success: true, message: 'Download já em andamento', state: updateState });
  }

  if (!updateState.downloadUrl) {
    return res.status(400).json({ success: false, error: 'Nenhum URL de download disponível. Execute /api/updates/check primeiro.' });
  }

  const targetFileName = updateState.assetName || `FYXXSSH-Setup-v${updateState.latestVersion}.exe`;
  const destPath = path.join(UPDATES_DIR, targetFileName);

  updateState.status = 'downloading';
  updateState.progress = 0;
  updateState.transferredBytes = 0;
  updateState.errorMessage = null;

  // Responde imediatamente para o cliente iniciar o polling de progresso
  res.json({ success: true, message: 'Download iniciado', state: updateState });

  downloadFileWithRedirects(updateState.downloadUrl, destPath, (transferred, total) => {
    updateState.transferredBytes = transferred;
    updateState.totalBytes = total || updateState.totalBytes;
    if (updateState.totalBytes > 0) {
      updateState.progress = Math.min(100, Math.round((transferred / updateState.totalBytes) * 100));
    }
  }).then(() => {
    updateState.status = 'ready';
    updateState.progress = 100;
    updateState.localInstallerPath = destPath;
  }).catch(err => {
    updateState.status = 'error';
    updateState.errorMessage = err.message;
  });
});

// ROTA 4: Executar instalador e fechar o app
app.post('/api/updates/install', (req, res) => {
  const installerPath = updateState.localInstallerPath;
  if (!installerPath || !fs.existsSync(installerPath)) {
    return res.status(400).json({ success: false, error: 'Arquivo do instalador não encontrado.' });
  }

  try {
    const { spawn } = require('child_process');
    // Inicia o instalador em processo desanexado do Node
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    res.json({ success: true, message: 'Instalador iniciado com sucesso. O FYXXSSH será reiniciado.' });

    // Encerra a instância atual após breve pausa para dar tempo de responder
    setTimeout(() => {
      process.exit(0);
    }, 1200);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao iniciar o instalador: ' + err.message });
  }
});

function createSFTPClient(host) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        resolve({ conn, sftp });
      });
    });
    conn.on('error', (err) => {
      reject(err);
    });
    conn.connect(getSSHConfig(host));
  });
}

// =================== CONFIGURAÇÕES ===================
app.get('/api/settings', (req, res) => {
  const data = loadStorage();
  res.json(data.settings || { theme: 'obsidian', layout: 'split-vertical' });
});

app.post('/api/settings', (req, res) => {
  const data = loadStorage();
  data.settings = { ...data.settings, ...req.body };
  saveStorage(data);
  res.json(data.settings);
});

// =================== CAPTURA INTELIGENTE DE DIRETÓRIO ATUAL ===================
app.post('/api/terminal/cwd', (req, res) => {
  const { hostId } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  const conn = new Client();
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { conn.end(); } catch (e) {}
      res.json({ cwd: '/root/' });
    }
  }, 4000);

  conn.on('ready', () => {
    // Comando inteligente que descobre o diretório do processo bash/sh mais recente do usuário conectado
    const cmd = `TARGET_PID=$(pgrep -u $(whoami) -n bash 2>/dev/null || pgrep -u $(whoami) -n sh 2>/dev/null); if [ -n "$TARGET_PID" ] && [ -d "/proc/$TARGET_PID/cwd" ]; then readlink -f /proc/$TARGET_PID/cwd; else pwd; fi`;

    conn.exec(cmd, (err, stream) => {
      if (err) {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          conn.end();
          return res.json({ cwd: '/root/' });
        }
      }

      let output = '';
      stream.on('data', chunk => { output += chunk.toString(); });
      stream.on('close', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          conn.end();
          let dir = output.trim();
          if (!dir || dir.length === 0) dir = '/root/';
          if (!dir.endsWith('/')) dir += '/';
          res.json({ cwd: dir });
        }
      });
    });
  });

  conn.on('error', () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.json({ cwd: '/root/' });
    }
  });

  try {
    conn.connect(getSSHConfig(host));
  } catch (err) {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.json({ cwd: '/root/' });
    }
  }
});

// =================== ROTAS DE SERVIDORES (HOSTS) ===================
app.get('/api/hosts', (req, res) => {
  const data = loadStorage();
  res.json(data.hosts || []);
});

app.post('/api/hosts', (req, res) => {
  try {
    const data = loadStorage();
    const newHost = {
      id: 'host_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: (req.body.name || '').trim() || 'Servidor SSH',
      host: (req.body.host || '').trim(),
      port: parseInt(req.body.port) || 22,
      username: (req.body.username || '').trim() || 'root',
      authType: req.body.authType === 'key' ? 'key' : 'password',
      password: req.body.password || '',
      privateKey: req.body.privateKey || '',
      color: req.body.color || '#3b82f6',
      createdAt: new Date().toISOString()
    };

    if (!newHost.host) {
      return res.status(400).json({ error: 'O endereço IP ou domínio do servidor é obrigatório' });
    }

    data.hosts.push(newHost);
    const saved = saveStorage(data);
    if (!saved) {
      return res.status(500).json({ error: 'Falha ao gravar arquivo de configuração' });
    }

    res.status(201).json(newHost);
  } catch (err) {
    console.error('Erro ao adicionar host:', err);
    res.status(500).json({ error: err.message });
  }
});

// EDIÇÃO DE SERVIDOR EXISTENTE
app.put('/api/hosts/:id', (req, res) => {
  try {
    const data = loadStorage();
    const index = data.hosts.findIndex(h => h.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Servidor não encontrado' });

    data.hosts[index] = {
      ...data.hosts[index],
      name: (req.body.name || '').trim() || data.hosts[index].name,
      host: (req.body.host || '').trim() || data.hosts[index].host,
      port: parseInt(req.body.port) || data.hosts[index].port,
      username: (req.body.username || '').trim() || data.hosts[index].username,
      authType: req.body.authType || data.hosts[index].authType,
      password: req.body.password !== undefined && req.body.password !== '' ? req.body.password : data.hosts[index].password,
      privateKey: req.body.privateKey !== undefined && req.body.privateKey !== '' ? req.body.privateKey : data.hosts[index].privateKey,
      color: req.body.color || data.hosts[index].color
    };

    saveStorage(data);
    res.json(data.hosts[index]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/hosts/:id', (req, res) => {
  const data = loadStorage();
  data.hosts = data.hosts.filter(h => h.id !== req.params.id);
  data.shortcuts = data.shortcuts.filter(s => s.hostId !== req.params.id);
  saveStorage(data);
  res.json({ success: true });
});

// =================== ROTAS DE ATALHOS DE DIRETÓRIO ===================
app.get('/api/shortcuts', (req, res) => {
  const data = loadStorage();
  const { hostId } = req.query;
  let shortcuts = data.shortcuts || [];
  if (hostId) {
    shortcuts = shortcuts.filter(s => s.hostId === hostId);
  }
  res.json(shortcuts);
});

app.post('/api/shortcuts', (req, res) => {
  try {
    const data = loadStorage();
    let cleanPath = req.body.path ? req.body.path.trim() : '/';
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
    if (!cleanPath.endsWith('/')) cleanPath = cleanPath + '/';

    let snippets = req.body.snippets || [];
    if (typeof snippets === 'string') {
      try {
        snippets = JSON.parse(snippets);
      } catch(e) {
        snippets = [];
      }
    }

    const newShortcut = {
      id: 'sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      hostId: req.body.hostId,
      name: (req.body.name || '').trim() || cleanPath,
      path: cleanPath,
      description: req.body.description || '',
      color: req.body.color || '#10b981',
      icon: req.body.icon || 'folder',
      snippets: snippets,
      createdAt: new Date().toISOString()
    };

    data.shortcuts.push(newShortcut);
    saveStorage(data);
    res.status(201).json(newShortcut);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EDIÇÃO DE ATALHO EXISTENTE
app.put('/api/shortcuts/:id', (req, res) => {
  try {
    const data = loadStorage();
    const index = data.shortcuts.findIndex(s => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Atalho não encontrado' });

    let cleanPath = req.body.path ? req.body.path.trim() : data.shortcuts[index].path;
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
    if (!cleanPath.endsWith('/')) cleanPath = cleanPath + '/';

    let snippets = req.body.snippets !== undefined ? req.body.snippets : data.shortcuts[index].snippets;
    if (typeof snippets === 'string') {
      try {
        snippets = JSON.parse(snippets);
      } catch(e) {
        snippets = [];
      }
    }

    data.shortcuts[index] = {
      ...data.shortcuts[index],
      hostId: req.body.hostId || data.shortcuts[index].hostId,
      name: (req.body.name || '').trim() || cleanPath,
      path: cleanPath,
      description: req.body.description !== undefined ? req.body.description : data.shortcuts[index].description,
      color: req.body.color || data.shortcuts[index].color,
      snippets: snippets
    };

    saveStorage(data);
    res.json(data.shortcuts[index]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/shortcuts/:id', (req, res) => {
  const data = loadStorage();
  data.shortcuts = data.shortcuts.filter(s => s.id !== req.params.id);
  saveStorage(data);
  res.json({ success: true });
});

// =================== TELEMETRIA DA VPS ===================
app.post('/api/vps-stats', (req, res) => {
  const { hostId } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Host não encontrado' });

  const conn = new Client();
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { conn.end(); } catch (e) {}
      res.status(504).json({ error: 'Timeout' });
    }
  }, 7000);

  conn.on('ready', () => {
    const cmd = `echo "CPU:$(top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}')%|RAM:$(free -m | awk 'NR==2{printf \\"%.1f/%.1f GB\\", $3/1024, $2/1024}')|DISK:$(df -h / | awk 'END{print $3 \\"/\\" $2}')|UPTIME:$(uptime -p 2>/dev/null || uptime | awk -F',' '{print $1}')"`;

    conn.exec(cmd, (err, stream) => {
      if (err) {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          conn.end();
          return res.status(500).json({ error: err.message });
        }
      }

      let output = '';
      stream.on('data', chunk => { output += chunk.toString(); });
      stream.on('close', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          conn.end();

          const parts = output.trim().split('|');
          const stats = {
            cpu: (parts[0] || '').replace('CPU:', ''),
            ram: (parts[1] || '').replace('RAM:', ''),
            disk: (parts[2] || '').replace('DISK:', ''),
            uptime: (parts[3] || '').replace('UPTIME:', '')
          };
          res.json({ success: true, stats });
        }
      });
    });
  });

  conn.on('error', (err) => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.status(500).json({ error: err.message });
    }
  });

  try {
    conn.connect(getSSHConfig(host));
  } catch (err) {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.status(500).json({ error: err.message });
    }
  }
});

// Suporte GET para telemetria
app.get(['/api/stats', '/api/vps-stats'], (req, res) => {
  const hostId = req.query.hostId;
  req.body = { hostId };
  app._router.handle({ ...req, method: 'POST', url: '/api/vps-stats' }, res);
});

// =================== TESTE DE CONEXÃO ===================
app.post('/api/test-connection', async (req, res) => {
  const { hostId, host, port, username, authType, password, privateKey } = req.body;
  let targetHost;

  if (hostId) {
    const data = loadStorage();
    targetHost = data.hosts.find(h => h.id === hostId);
  } else {
    targetHost = { host, port, username, authType, password, privateKey };
  }

  if (!targetHost || !targetHost.host) {
    return res.status(400).json({ error: 'Configuração do Servidor incompleta' });
  }

  const conn = new Client();
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      try { conn.end(); } catch (e) {}
      res.status(504).json({ success: false, error: 'Tempo limite esgotado (Timeout de 10s)' });
    }
  }, 10000);

  conn.on('ready', () => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      conn.end();
      res.json({ success: true, message: 'Conexão SSH bem-sucedida!' });
    }
  });

  conn.on('error', (err) => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  try {
    conn.connect(getSSHConfig(targetHost));
  } catch (err) {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// =================== SFTP ENDPOINTS ===================
app.post('/api/sftp/list', async (req, res) => {
  const { hostId, remotePath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const targetPath = remotePath || '/root';

    sftp.readdir(targetPath, (err, list) => {
      conn.end();
      if (err) {
        return res.status(500).json({ error: `Erro ao listar ${targetPath}: ${err.message}` });
      }

      const items = list.map(item => {
        const isDirectory = (item.attrs.mode & 0o40000) === 0o40000;
        const isLink = (item.attrs.mode & 0o120000) === 0o120000;
        return {
          name: item.filename,
          isDirectory,
          isLink,
          size: item.attrs.size,
          mtime: item.attrs.mtime * 1000,
          permissions: (item.attrs.mode & 0o777).toString(8)
        };
      });

      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      res.json({ path: targetPath, items });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/read', async (req, res) => {
  const { hostId, filePath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const stream = sftp.createReadStream(filePath);
    let content = '';

    stream.on('data', chunk => {
      content += chunk.toString('utf-8');
      if (content.length > 5 * 1024 * 1024) {
        stream.destroy();
        conn.end();
        return res.status(413).json({ error: 'Arquivo muito grande (máximo 5MB)' });
      }
    });

    stream.on('end', () => {
      conn.end();
      res.json({ content, filePath });
    });

    stream.on('error', (err) => {
      conn.end();
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/write', async (req, res) => {
  const { hostId, filePath, content } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const writeStream = sftp.createWriteStream(filePath);

    writeStream.on('close', () => {
      conn.end();
      res.json({ success: true, message: 'Arquivo salvo com sucesso!' });
    });

    writeStream.on('error', (err) => {
      conn.end();
      res.status(500).json({ error: err.message });
    });

    writeStream.write(content);
    writeStream.end();
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/mkdir', async (req, res) => {
  const { hostId, dirPath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    sftp.mkdir(dirPath, (err) => {
      conn.end();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sftp/delete', async (req, res) => {
  const { hostId, itemPath, isDirectory } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    if (isDirectory) {
      sftp.rmdir(itemPath, (err) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    } else {
      sftp.unlink(itemPath, (err) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// VERIFICAÇÃO RÁPIDA DE ARQUIVOS EXISTENTES (PREVENÇÃO DE CONFLITO)
app.post('/api/sftp/check-exists', async (req, res) => {
  const { hostId, remotePath, filenames } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });
  if (!Array.isArray(filenames)) return res.json({ existing: [] });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    sftp.readdir(remotePath || '/root', (err, list) => {
      conn.end();
      if (err) {
        return res.json({ existing: [] });
      }

      const remoteNames = new Set(list.map(i => i.filename));
      const existing = filenames.filter(fn => remoteNames.has(fn));
      res.json({ existing });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.json({ existing: [] });
  }
});

// RENOMEAR ARQUIVO OU PASTA
app.post('/api/sftp/rename', async (req, res) => {
  const { hostId, oldPath, newPath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });
  if (!oldPath || !newPath) return res.status(400).json({ error: 'Caminhos de origem e destino são obrigatórios' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    sftp.rename(oldPath, newPath, (err) => {
      conn.end();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Renomeado com sucesso!' });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// DUPLICAR ARQUIVO
app.post('/api/sftp/duplicate', async (req, res) => {
  const { hostId, filePath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const newPath = path.join(dir, `${base}_copia${ext}`).replace(/\\/g, '/');

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const readStream = sftp.createReadStream(filePath);
    const writeStream = sftp.createWriteStream(newPath);

    readStream.pipe(writeStream);

    writeStream.on('close', () => {
      conn.end();
      res.json({ success: true, newPath });
    });

    writeStream.on('error', (err) => {
      conn.end();
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// ALTERAR PERMISSÕES (CHMOD)
app.post('/api/sftp/chmod', async (req, res) => {
  const { hostId, filePath, mode } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const octalMode = parseInt(mode || '755', 8);
    sftp.chmod(filePath, octalMode, (err) => {
      conn.end();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// PREPARAR ARQUIVO PARA ARRASTAR PARA O WINDOWS (DRAG-OUT)
app.post('/api/sftp/prepare-drag', async (req, res) => {
  const { hostId, remotePath } = req.body;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).json({ error: 'Servidor não encontrado' });

  const tempDir = path.join(os.tmpdir(), 'FYXXSSH_Drag');
  fs.mkdirSync(tempDir, { recursive: true });

  const filename = path.basename(remotePath);
  const localDest = path.join(tempDir, filename);

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    sftp.fastGet(remotePath, localDest, { concurrency: 64, chunkSize: 65536 }, (err) => {
      conn.end();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, localPath: localDest, filename });
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// UPLOAD DE ALTA PERFORMANCE COM SUPORTE A RESOLUÇÃO DE CONFLITO
app.post('/api/sftp/upload', upload.single('file'), async (req, res) => {
  const { hostId, remotePath, targetFilename, conflictAction } = req.body;
  const localFile = req.file;

  if (!localFile) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);
  if (!host) {
    fs.unlinkSync(localFile.path);
    return res.status(404).json({ error: 'Servidor não encontrado' });
  }

  // Nome final definido pelo frontend ou original
  const finalFilename = (targetFilename || localFile.originalname).trim();

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const normalizedRemotePath = remotePath.endsWith('/') 
      ? remotePath + finalFilename 
      : remotePath + '/' + finalFilename;

    // fastPut com chunk de 64KB e alta concorrência para taxa de megabytes/segundo máxima
    sftp.fastPut(localFile.path, normalizedRemotePath, { concurrency: 64, chunkSize: 65536 }, (err) => {
      fs.unlinkSync(localFile.path);
      conn.end();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: `Upload concluído: ${normalizedRemotePath}`, filename: finalFilename });
    });
  } catch (err) {
    if (fs.existsSync(localFile.path)) fs.unlinkSync(localFile.path);
    if (client && client.conn) client.conn.end();
    res.status(500).json({ error: err.message });
  }
});

// DOWNLOAD DE ALTA VELOCIDADE COM BUFFER OTIMIZADO
app.get('/api/sftp/download', async (req, res) => {
  const { hostId, filePath } = req.query;
  const data = loadStorage();
  const host = data.hosts.find(h => h.id === hostId);

  if (!host) return res.status(404).send('Servidor não encontrado');

  let client;
  try {
    client = await createSFTPClient(host);
    const { conn, sftp } = client;

    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const readStream = sftp.createReadStream(filePath, { highWaterMark: 128 * 1024 });
    readStream.pipe(res);

    readStream.on('end', () => {
      conn.end();
    });

    readStream.on('error', (err) => {
      conn.end();
      if (!res.headersSent) res.status(500).send(err.message);
    });
  } catch (err) {
    if (client && client.conn) client.conn.end();
    res.status(500).send(err.message);
  }
});

// =================== WEBSOCKET (TERMINAL INTERATIVO SSH) ===================
wss.on('connection', (ws) => {
  let sshClient = null;
  let sshStream = null;
  let hasNavigated = false;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'init') {
        const hostId = msg.hostId;
        const initialTargetDir = msg.initialDir || msg.initialPath || '';
        const cols = parseInt(msg.cols, 10) || 80;
        const rows = parseInt(msg.rows, 10) || 24;
        const data = loadStorage();
        const host = data.hosts.find(h => h.id === hostId);

        if (!host) {
          ws.send(JSON.stringify({ type: 'error', data: 'Servidor não encontrado nos registros.\r\n' }));
          return ws.close();
        }

        sshClient = new Client();

        sshClient.on('ready', () => {
          ws.send(JSON.stringify({ type: 'status', data: '✔ Conexão estabelecida com sucesso!\r\n' }));

          sshClient.shell({
            term: 'xterm-256color',
            cols: cols,
            rows: rows
          }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', data: `Erro ao iniciar shell interativo: ${err.message}\r\n` }));
              return ws.close();
            }

            sshStream = stream;

            // Injeção garantida do diretório remoto
            const executeDirectoryChange = () => {
              if (hasNavigated) return;
              if (initialTargetDir && initialTargetDir.trim().length > 0 && initialTargetDir.trim() !== '/' && initialTargetDir.trim() !== '/root') {
                hasNavigated = true;
                const targetDir = initialTargetDir.trim();
                setTimeout(() => {
                  try {
                    stream.write(`cd "${targetDir}" && clear\n`);
                  } catch (e) {}
                }, 150);
              }
            };

            stream.on('data', (d) => {
              ws.send(JSON.stringify({ type: 'output', data: d.toString('utf-8') }));
              if (!hasNavigated) {
                executeDirectoryChange();
              }
            });

            stream.on('close', () => {
              ws.send(JSON.stringify({ type: 'status', data: '\r\nSessão encerrada pelo servidor remoto.\r\n' }));
              sshClient.end();
              ws.close();
            });

            setTimeout(() => {
              executeDirectoryChange();
            }, 500);
          });
        });

        sshClient.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', data: `Erro de conexão SSH: ${err.message}\r\n` }));
        });

        sshClient.on('close', () => {
          ws.send(JSON.stringify({ type: 'status', data: 'Conexão finalizada.\r\n' }));
        });

        sshClient.connect(getSSHConfig(host));
      } else if (msg.type === 'data' || msg.type === 'input') {
        if (sshStream && msg.data !== undefined) {
          try {
            sshStream.write(msg.data);
          } catch(e) {
            console.error('Erro ao escrever no sshStream:', e);
          }
        }
      } else if (msg.type === 'command') {
        if (sshStream && msg.command) {
          try {
            sshStream.write(msg.command + '\n');
          } catch(e) {}
        }
      } else if (msg.type === 'resize') {
        if (sshStream && msg.cols && msg.rows) {
          try {
            sshStream.setWindow(parseInt(msg.rows, 10), parseInt(msg.cols, 10), 0, 0);
          } catch(e) {}
        }
      }
    } catch (e) {
      console.error('Erro no parser WebSocket:', e);
    }
  });

  ws.on('close', () => {
    if (sshStream) {
      try { sshStream.end(); } catch (e) {}
    }
    if (sshClient) {
      try { sshClient.end(); } catch (e) {}
    }
  });
});

function startServer(preferredPort = 4321) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;

    function tryListen() {
      server.removeAllListeners('error');
      
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[FYXXSSH Server] Porta ${port} ocupada, tentando ${port + 1}...`);
          port++;
          setTimeout(tryListen, 50);
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        console.log(`=======================================================`);
        console.log(`⚡ FYXXSSH Studio Server ativo com sucesso em http://127.0.0.1:${port}`);
        console.log(`📁 Armazenamento em: ${DATA_FILE}`);
        console.log(`=======================================================`);
        resolve(port);
      });
    }

    tryListen();
  });
}

if (require.main === module) {
  startServer(PORT).catch(err => {
    console.error('Falha ao iniciar servidor:', err);
  });
}

module.exports = { app, server, startServer, PORT };
