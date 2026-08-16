import { app, BrowserWindow, ipcMain, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir } from './config-dir';
import { loadProfiles } from './profiles';
import { loadSettings, saveSettings } from './settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configDir = resolveConfigDir({
  platform: process.platform,
  homeDir: os.homedir(),
  appData: process.env.APPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
});

async function createWindow(): Promise<void> {
  const settings = await loadSettings(configDir);
  const { width, height, maximized } = settings.window;

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0F172A',
    title: 'PrintPilot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (maximized) win.maximize();

  // Persist window state on close (design doc §4: settings.json window state).
  win.on('close', () => {
    const bounds = win.getBounds();
    void saveSettings(configDir, {
      ...settings,
      window: { width: bounds.width, height: bounds.height, maximized: win.isMaximized() },
    });
  });

  // External links open in the system browser, never in the shell window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', async () => {
    const profiles = await loadProfiles(configDir);
    return {
      version: app.getVersion(),
      platform: process.platform,
      configDir,
      profileCount: profiles.printers.length,
    };
  });
}

void app.whenReady().then(() => {
  registerIpc();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
