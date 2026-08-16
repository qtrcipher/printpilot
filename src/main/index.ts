import { app, BrowserWindow, ipcMain, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir } from './config-dir';
import { createSafeStorageCipher } from './credentials';
import {
  createOfflineDiscoveryService,
  isValidHostname,
  isValidIpv4,
  type DiscoveredPrinter,
} from './discovery';
import { createDiscoveryService } from './discovery-net';
import { loadProfiles, ProfileStore, type NewProfile, type PrinterProfile } from './profiles';
import { loadSettings, saveSettings } from './settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configDir = resolveConfigDir({
  platform: process.platform,
  homeDir: os.homedir(),
  appData: process.env.APPDATA,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
});

// Deterministic no-network discovery for the Playwright e2e suite (CI has no
// printers; relying on real mDNS/timeouts there would be flaky).
const discovery =
  process.env.PRINTPILOT_FAKE_DISCOVERY === '1'
    ? createOfflineDiscoveryService()
    : createDiscoveryService();

const profileStore = new ProfileStore(configDir, createSafeStorageCipher());

const scanWindowMs = Number.parseInt(process.env.PRINTPILOT_SCAN_WINDOW_MS ?? '', 10) || 5000;

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
      scanWindowMs,
    };
  });

  // --- Discovery (design doc §3) -------------------------------------------
  ipcMain.handle('discovery:start', () => {
    discovery.stop();
    discovery.clear();
    discovery.start();
  });
  ipcMain.handle('discovery:stop', () => {
    discovery.stop();
  });
  ipcMain.handle('discovery:check-manual', (_event, ip: unknown) => {
    const host = assertString(ip, 'ip', 64);
    if (!isValidIpv4(host)) throw new Error('Not a valid IPv4 address');
    return discovery.checkManualHost(host);
  });

  // --- Profiles (design doc §4) --------------------------------------------
  ipcMain.handle('profiles:list', async () => (await profileStore.list()).map(stripCredential));
  ipcMain.handle('profiles:add', async (_event, input: unknown) =>
    stripCredential(await profileStore.add(validateNewProfile(input))),
  );
  ipcMain.handle('profiles:remove', (_event, id: unknown) =>
    profileStore.remove(assertString(id, 'id', 64)),
  );
  ipcMain.handle('profiles:rename', async (_event, id: unknown, nickname: unknown) =>
    stripCredential(
      await profileStore.rename(assertString(id, 'id', 64), assertString(nickname, 'nickname', 80)),
    ),
  );
  ipcMain.handle('profiles:set-credential', async (_event, id: unknown, secret: unknown) => {
    const value = assertString(secret, 'credential', 200);
    await profileStore.setCredential(assertString(id, 'id', 64), value);
  });
  ipcMain.handle('profiles:get-credential', (_event, id: unknown) =>
    profileStore.getCredential(assertString(id, 'id', 64)),
  );
}

/** The encrypted credential blob never crosses into the renderer. */
function stripCredential(profile: PrinterProfile | null): Omit<PrinterProfile, 'credentialEnc'> | null {
  if (!profile) return null;
  const { credentialEnc: _dropped, ...pub } = profile;
  return pub;
}

function assertString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > maxLen) throw new Error(`${name} is too long`);
  return trimmed;
}

function validateNewProfile(input: unknown): NewProfile {
  if (typeof input !== 'object' || input === null) throw new Error('profile must be an object');
  const raw = input as Record<string, unknown>;
  const host = assertString(raw.host, 'host', 253);
  if (!isValidIpv4(host) && !isValidHostname(host)) {
    throw new Error('host must be an IPv4 address or hostname');
  }
  return {
    nickname: assertString(raw.nickname, 'nickname', 80),
    host,
    vendor: typeof raw.vendor === 'string' ? raw.vendor.slice(0, 40) : '',
    model: typeof raw.model === 'string' ? raw.model.slice(0, 80) : '',
    adapter: assertString(raw.adapter, 'adapter', 80),
  };
}

function broadcastDiscoveryEvents(): void {
  const send = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  };
  discovery.onPrinterFound((printer: DiscoveredPrinter) => {
    send('discovery:printer-found', printer);
  });
  discovery.onError((err) => {
    send('discovery:error', err.message);
  });
}

void app.whenReady().then(() => {
  registerIpc();
  broadcastDiscoveryEvents();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  discovery.stop();
});
