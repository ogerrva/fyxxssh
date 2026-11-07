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

// Helpers SSH
function getSSHConfig(host) {
  const config = {
    host: host.host,
    port: parseInt(host.port) || 22,
    username: host.username || 'root',
    readyTimeout: 25000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    // Otimização máxima de velocidade e conexão: Ciphers modernos de aceleração por hardware
    algorithms: {
      kex: [
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'ecdh-sha2-nistp256',
        'diffie-hellman-group-exchange-sha256',
        'diffie-hellman-group14-sha256'
      ],
      cipher: [
        'chacha20-poly1305@openssh.com',
        'aes128-gcm@openssh.com',
        'aes256-gcm@openssh.com',
        'aes128-ctr',
        'aes192-ctr',
        'aes256-ctr'
      ],
      serverHostKey: [
        'ssh-ed25519',
        'ecdsa-sha2-nistp256',
        'rsa-sha2-512',
        'rsa-sha2-256',
        'ssh-rsa'
      ],
      compress: ['none', 'zlib@openssh.com']
    }
  };

  if (host.authType === 'key' && host.privateKey) {
    config.privateKey = host.privateKey;
    if (host.passphrase) config.passphrase = host.passphrase;
  } else {
    config.password = host.password || '';
  }

  return config;
}

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
    const cmd = `echo "CPU:$(top -bn1 | grep 'Cpu(s)' | awk '{print $2}')%|RAM:$(free -m | awk '/Mem:/ {printf \\"%d/%dMB (%.1f%%)\\", $3, $2, $3*100/$2}')|DISK:$(df -h / | awk 'NR==2 {print $3\\"/\\"$2\\" (\\"$5\\")\\"}')|UPTIME:$(uptime -p 2>/dev/null || uptime | awk -F',' '{print $1}')"`;

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
        const { hostId, initialPath, cols, rows } = msg;
        const data = loadStorage();
        const host = data.hosts.find(h => h.id === hostId);

        if (!host) {
          ws.send(JSON.stringify({ type: 'error', data: 'Servidor não encontrado nos registros.\r\n' }));
          return ws.close();
        }

        sshClient = new Client();

        sshClient.on('ready', () => {
          ws.send(JSON.stringify({ type: 'status', data: '✔ Conectado ao servidor! Inicializando PTY...\r\n' }));

          sshClient.shell({
            term: 'xterm-256color',
            cols: cols || 90,
            rows: rows || 28
          }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', data: `Erro ao iniciar shell: ${err.message}\r\n` }));
              return ws.close();
            }

            sshStream = stream;

            // Injeção garantida do diretório remoto
            const executeDirectoryChange = () => {
              if (hasNavigated) return;
              if (initialPath && initialPath.trim().length > 0 && initialPath.trim() !== '/' && initialPath.trim() !== '/root') {
                hasNavigated = true;
                const targetDir = initialPath.trim();
                setTimeout(() => {
                  stream.write(`cd "${targetDir}" && clear\n`);
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
            }, 600);
          });
        });

        sshClient.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', data: `Erro de conexão SSH: ${err.message}\r\n` }));
        });

        sshClient.on('close', () => {
          ws.send(JSON.stringify({ type: 'status', data: 'Conexão finalizada.\r\n' }));
        });

        sshClient.connect(getSSHConfig(host));
      } else if (msg.type === 'data') {
        if (sshStream) {
          sshStream.write(msg.data);
        }
      } else if (msg.type === 'command') {
        if (sshStream && msg.command) {
          sshStream.write(msg.command + '\n');
        }
      } else if (msg.type === 'resize') {
        if (sshStream && msg.cols && msg.rows) {
          sshStream.setWindow(msg.rows, msg.cols, 0, 0);
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
