// desktop/main.js — Electron main process for oukos-clip
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IS_DEV = !app.isPackaged;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESOURCES = IS_DEV ? PROJECT_ROOT : process.resourcesPath;

// Bundled binaries: resources/bin when packaged, desktop/bin in dev. Falls back to PATH.
const BIN_DIR = IS_DEV ? path.join(__dirname, 'bin') : path.join(process.resourcesPath, 'bin');

function binaryPath(name) {
  const full = path.join(BIN_DIR, `${name}.exe`);
  return fs.existsSync(full) ? full : name;
}

const FFMPEG_PATH = binaryPath('ffmpeg');
let YTDLP_PATH = binaryPath('yt-dlp');
// Face detection runs in-process with onnxruntime-node (no Python needed).
const ORT_PATH = path.join(__dirname, 'node_modules', 'onnxruntime-node');
// The backend is plain JS built from ../src by scripts/build-backend.mjs.
const BACKEND_ENTRY = path.join(__dirname, 'backend', 'server.js');

// User data
const USER_DATA = app.getPath('userData');
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  clipsPerVideo: 5,
  minClipSeconds: 20,
  maxClipSeconds: 75,
  outputHeight: 1280,
  burnCaptions: true,
  reframe: 'auto',
  outputDir: '',
  captionLanguage: '',
};

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// Also try to load a .env from userData for backward compat
function loadDotEnv() {
  const envFile = path.join(USER_DATA, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ---------------------------------------------------------------------------
// yt-dlp: YouTube changes often, so keep a self-updating copy in userData
// (the install folder isn't writable for normal users).
// ---------------------------------------------------------------------------

function prepareYtDlp() {
  const bundled = binaryPath('yt-dlp');
  if (!path.isAbsolute(bundled)) return; // not bundled; using PATH
  const userCopy = path.join(USER_DATA, 'bin', 'yt-dlp.exe');
  try {
    fs.mkdirSync(path.dirname(userCopy), { recursive: true });
    if (!fs.existsSync(userCopy)) fs.copyFileSync(bundled, userCopy);
    YTDLP_PATH = userCopy;
    // Update in the background; the next backend start picks up the new version.
    const updater = spawn(userCopy, ['-U'], { windowsHide: true, stdio: 'ignore' });
    updater.on('error', () => {});
  } catch (err) {
    console.warn('Could not prepare yt-dlp copy, using bundled one:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Free port
// ---------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForBackend(port, timeoutMs = 10000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.on('error', retry);
      request.setTimeout(1000, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('The backend did not become reachable in time.'));
        return;
      }
      setTimeout(probe, 100);
    };

    probe();
  });
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

let backendProcess = null;
let backendPort = null;

function buildBackendEnv(port, settings) {
  const env = { ...process.env };
  env.PORT = String(port);
  env.FFMPEG_PATH = FFMPEG_PATH;
  env.YTDLP_PATH = YTDLP_PATH;
  env.ORT_PATH = ORT_PATH;
  // Folder holding public/, models/, tools/ (repo root in dev, resources/ when packaged).
  env.APP_ROOT = RESOURCES;
  // Run the backend on Electron's own Node, so users don't need Node.js installed.
  env.ELECTRON_RUN_AS_NODE = '1';

  if (settings.geminiApiKey) env.GEMINI_API_KEY = settings.geminiApiKey;
  if (settings.geminiModel) env.GEMINI_MODEL = settings.geminiModel;
  if (settings.clipsPerVideo) env.CLIPS_PER_VIDEO = String(settings.clipsPerVideo);
  if (settings.minClipSeconds) env.MIN_CLIP_SECONDS = String(settings.minClipSeconds);
  if (settings.maxClipSeconds) env.MAX_CLIP_SECONDS = String(settings.maxClipSeconds);
  if (settings.outputHeight) env.OUTPUT_HEIGHT = String(settings.outputHeight);
  if (typeof settings.burnCaptions === 'boolean') env.BURN_CAPTIONS = String(settings.burnCaptions);
  if (settings.reframe) env.REFRAME = settings.reframe;
  if (settings.captionLanguage) env.CAPTION_LANGUAGE = settings.captionLanguage;
  if (settings.outputDir) env.OUTPUT_DIR = settings.outputDir;

  // Tell the backend-runner where extraResources live when packaged
  if (!IS_DEV) {
    env.OUKOS_RESOURCES_PATH = RESOURCES;
    env.DATA_DIR = path.join(USER_DATA, 'data');
    if (!settings.outputDir) {
      env.OUTPUT_DIR = path.join(USER_DATA, 'output');
    }
  }

  return env;
}

async function startBackend() {
  const port = await findFreePort();
  backendPort = port;

  const settings = readSettings();
  const env = buildBackendEnv(port, settings);

  if (!fs.existsSync(BACKEND_ENTRY)) {
    throw new Error('Backend not built. Run "npm run build:backend" in the desktop folder.');
  }

  // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it behave as plain Node.
  backendProcess = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: IS_DEV ? PROJECT_ROOT : RESOURCES,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let resolved = false;
    let readyCheckStarted = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('The backend did not start in time.'));
      }
    }, 15000);

    const markReady = async () => {
      if (resolved || readyCheckStarted) return;
      readyCheckStarted = true;
      try {
        await waitForBackend(port);
        resolved = true;
        clearTimeout(timeout);
        resolve(port);
      } catch (error) {
        resolved = true;
        clearTimeout(timeout);
        reject(error);
      }
    };

    // Also watch stdout for the "running at" line
    backendProcess.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(`[backend] ${text}`);
      if (text.includes('oukos-clip running at')) void markReady();
    });

    backendProcess.stderr.on('data', (data) => {
      process.stderr.write(`[backend:err] ${data}`);
    });

    backendProcess.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    backendProcess.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Backend exited with code ${code}`));
      }
      backendProcess = null;
    });
  });
}

function killBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

async function restartBackend() {
  killBackend();
  return startBackend();
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;

function getOutputDir() {
  const settings = readSettings();
  if (settings.outputDir) return settings.outputDir;
  return IS_DEV ? path.join(PROJECT_ROOT, 'output') : path.join(USER_DATA, 'output');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e0f11',
      symbolColor: '#ecedef',
      height: 38,
    },
    backgroundColor: '#0e0f11',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the application menu on Windows
  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('backend-ready');
  });

  let toldAboutTray = false;
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      // Closing only hides the window (clips keep rendering). Say so once, so it doesn't look like the app vanished.
      if (!toldAboutTray && Notification.isSupported()) {
        toldAboutTray = true;
        new Notification({
          title: 'oukos clip is still running',
          body: 'It keeps working in the background. Click the app icon or the tray icon to open it, or right-click the tray icon > Quit.',
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 650,
    resizable: false,
    parent: mainWindow,
    modal: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e0f11',
      symbolColor: '#ecedef',
      height: 38,
    },
    backgroundColor: '#0e0f11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  Menu.setApplicationMenu(null);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // 16x16 transparent fallback so the tray still works without an icon file
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('oukos clip');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      },
    },
    {
      label: 'Open Output Folder',
      click: () => {
        const dir = getOutputDir();
        fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIPC() {
  ipcMain.handle('select-output-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select output folder',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('open-output-folder', async () => {
    const dir = getOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('open-external-link', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('show-notification', async (_event, title, body) => {
    if (Notification.isSupported()) {
      new Notification({ title: String(title), body: String(body) }).show();
    }
  });

  ipcMain.handle('get-settings', () => {
    return readSettings();
  });

  ipcMain.handle('save-settings', async (_event, settings) => {
    if (typeof settings !== 'object' || settings === null) return;
    const current = readSettings();
    const merged = { ...current, ...settings };
    writeSettings(merged);
    return merged;
  });

  ipcMain.handle('restart-backend', async () => {
    const port = await restartBackend();
    // Reload the main window to point at the new port
    if (mainWindow) {
      mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
    return { port };
  });

  ipcMain.handle('get-app-info', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
    );
    return {
      version: pkg.version,
      outputDir: getOutputDir(),
      dataDir: USER_DATA,
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle('open-settings', () => {
    createSettingsWindow();
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Only one copy may run: two copies would fight over the same jobs and files.
// Opening the app again just brings the existing window to the front.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on('second-instance', showMainWindow);

app.whenReady().then(async () => {
  loadDotEnv();
  prepareYtDlp();
  registerIPC();

  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox(
      'Backend failed to start',
      `Could not start the oukos-clip backend.\n\n${err.message}`
    );
    app.quit();
    return;
  }

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // On Windows, don't quit — the tray keeps the app alive.
  // (macOS would naturally keep running.)
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  killBackend();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
