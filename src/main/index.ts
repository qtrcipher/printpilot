import { app, BrowserWindow, ipcMain, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAdapterManifests } from './adapters-load';
import { resolveAdapter, type AdapterManifest } from './adapters';
import { resolveConfigDir } from './config-dir';
import { createSafeStorageCipher } from './credentials';
import {
  createOfflineDiscoveryService,
  DiscoveryService,
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
// printers; relying on real mDNS/timeouts there would be flaky). When
// PRINTPILOT_FAKE_PRINTER_HOST is set, the stub "discovers" one printer so
// e2e can drive the control view against a local fixture server.
const discovery = (() => {
  if (process.env.PRINTPILOT_FAKE_DISCOVERY !== '1') return createDiscoveryService();
  const fakeHost = process.env.PRINTPILOT_FAKE_PRINTER_HOST;
  const fakePort = Number.parseInt(process.env.PRINTPILOT_FAKE_PRINTER_PORT ?? '', 10) || 80;
  if (!fakeHost) return createOfflineDiscoveryService();
  return new DiscoveryService({
    mdns: {
      start: (onUp) => {
        onUp({ name: 'Fixture Printer', host: fakeHost, port: fakePort, addresses: [fakeHost] });
      },
      stop: () => undefined,
    },
    http: { getRoot: () => Promise.resolve({ reachable: false, body: '' }) },
  });
})();

const profileStore = new ProfileStore(configDir, createSafeStorageCipher());

// Adapter manifests are data files shipped in the bundle (design doc §4);
// app.getAppPath() is the project root in dev/e2e and the asar root when
// packaged (adapters/** is included in electron-builder.yml files).
const adaptersDir = path.join(app.getAppPath(), 'adapters');
let cachedManifests: AdapterManifest[] | null = null;
async function adapterManifests(): Promise<AdapterManifest[]> {
  cachedManifests ??= await loadAdapterManifests(adaptersDir);
  return cachedManifests;
}

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
      webviewTag: true, // control view embeds the Remote UI via <webview>
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

  // --- Control view (design doc §3: embedded Remote UI) ---------------------
  ipcMain.handle('control:connect', async (_event, input: unknown) => {
    const target = validateConnectTarget(input);
    const manifests = await adapterManifests();
    const { adapter, matched } = resolveAdapter(manifests, {
      vendor: target.vendor,
      model: target.model,
      adapterId: target.adapter,
    });
    if (target.profileId) {
      // Best-effort bookkeeping; a stale id must not block connecting.
      await profileStore.touchLastConnected(target.profileId).catch(() => undefined);
    }
    return {
      url: `http://${target.host}:${target.port}/`,
      preloadUrl: pathToFileURL(path.join(__dirname, '../preload/webview.mjs')).href,
      adapter,
      adapterMatched: matched,
    };
  });

  ipcMain.handle('control:open-external', (_event, url: unknown) => {
    const value = assertString(url, 'url', 300);
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs can be opened externally');
    }
    return shell.openExternal(value);
  });
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

export interface ConnectTarget {
  nickname: string;
  host: string;
  port: number;
  vendor: string;
  model: string;
  adapter: string;
  profileId?: string;
}

function validateConnectTarget(input: unknown): ConnectTarget {
  if (typeof input !== 'object' || input === null) throw new Error('target must be an object');
  const raw = input as Record<string, unknown>;
  const host = assertString(raw.host, 'host', 253);
  if (!isValidIpv4(host) && !isValidHostname(host)) {
    throw new Error('host must be an IPv4 address or hostname');
  }
  let port = 80;
  if (raw.port !== undefined) {
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      throw new Error('port must be an integer between 1 and 65535');
    }
    port = raw.port;
  }
  const target: ConnectTarget = {
    nickname: assertString(raw.nickname, 'nickname', 80),
    host,
    port,
    vendor: typeof raw.vendor === 'string' ? raw.vendor.slice(0, 40) : '',
    model: typeof raw.model === 'string' ? raw.model.slice(0, 80) : '',
    adapter: typeof raw.adapter === 'string' ? raw.adapter.slice(0, 80) : '',
  };
  if (typeof raw.profileId === 'string' && raw.profileId.trim()) {
    target.profileId = assertString(raw.profileId, 'profileId', 64);
  }
  return target;
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
