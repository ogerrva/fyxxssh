const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(process.env.APPDATA ? path.join(process.env.APPDATA, 'FYXXSSH') : __dirname, 'electron.log');
function logDebug(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

logDebug('--- FYXXSSH iniciando ---');

// =================== SINGLE INSTANCE LOCK ===================
const gotTheLock = app.requestSingleInstanceLock();
logDebug(`gotTheLock: ${gotTheLock}`);

let mainWindow = null;
let serverInstance = null;
let serverPort = 4321;

if (!gotTheLock) {
  logDebug('Instancia secundaria detectada. Saindo...');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    logDebug('second-instance evento disparado! Focando janela.');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function startInternalServer() {
    try {
      logDebug('Iniciando startInternalServer...');
      const serverModule = require('./server.js');
      serverInstance = serverModule.server;
      if (typeof serverModule.startServer === 'function') {
        serverPort = await serverModule.startServer(4321);
      }
      logDebug(`Servidor backend ativo na porta: ${serverPort}`);
      return serverPort;
    } catch (err) {
      logDebug(`ERRO no startInternalServer: ${err.stack || err.message}`);
      return 4321;
    }
  }

  function createWindow(port) {
    logDebug(`Criando BrowserWindow com porta ${port}...`);
    mainWindow = new BrowserWindow({
      title: 'FYXXSSH',
      width: 1300,
      height: 840,
      minWidth: 1024,
      minHeight: 680,
      backgroundColor: '#070a0f',
      frame: false,
      titleBarStyle: 'hidden',
      icon: path.join(__dirname, 'build/icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false
      },
      show: true
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logDebug(`did-fail-load: ${errorCode} ${errorDescription}`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`http://127.0.0.1:${port}`);
        }
      }, 500);
    });

    mainWindow.webContents.on('crashed', (e) => {
      logDebug(`webContents crashed!`);
    });

    const targetUrl = `http://127.0.0.1:${port}`;
    logDebug(`Carregando URL: ${targetUrl}`);
    mainWindow.loadURL(targetUrl);

    mainWindow.on('closed', () => {
      logDebug('mainWindow fechada pelo usuario.');
      mainWindow = null;
    });
  }

  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    logDebug('IPC window-close recebido');
    if (mainWindow) mainWindow.close();
  });

  ipcMain.on('start-drag', (event, filePath) => {
    if (filePath && mainWindow) {
      event.sender.startDrag({
        file: filePath,
        icon: path.join(__dirname, 'public/icons/drag-file.png')
      });
    }
  });

  app.whenReady().then(async () => {
    logDebug('app.whenReady disparado');
    const activePort = await startInternalServer();
    createWindow(activePort);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(serverPort);
    });
  });

  app.on('window-all-closed', () => {
    logDebug('window-all-closed disparado');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    logDebug('will-quit disparado');
    if (serverInstance) {
      try {
        serverInstance.close();
      } catch (e) {}
    }
  });
}
