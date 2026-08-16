import { app, BrowserWindow, clipboard, ipcMain, session, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAdapterManifests } from './adapters-load';
import { resolveAdapter, type AdapterManifest } from './adapters';
import { resolveConfigDir } from './config-dir';
import { consumeCrashFlag, formatCrashEntry, markCrash, type CrashDetails, type CrashKind } from './crash';
import { createSafeStorageCipher } from './credentials';
import { buildDiagnostics } from './diagnostics';
import {
  createOfflineDiscoveryService,
  DiscoveryService,
  isValidHostname,
  isValidIpv4,
  type DiscoveredPrinter,
} from './discovery';
import { createDiscoveryService } from './discovery-net';
import { createLogger, type Logger, type LogLevel } from './logger';
import { loadProfiles, ProfileStore, type NewProfile, type PrinterProfile } from './profiles';
import { decideNavigation, permissionDecision } from './security';
import { loadSettings, saveSettings, updateSettings, validateSettingsPatch } from './settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// PRINTPILOT_CONFIG_DIR isolates e2e runs from the developer's real config
// (onboarding flag, profiles) — same mechanism as the fake-discovery hook.
const configDir =
  process.env.PRINTPILOT_CONFIG_DIR ??
  resolveConfigDir({
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

// Rotating local log (design doc §5). app.getPath('logs') is only reliable
// once the app is ready, so the logger is created in whenReady; `logger()`
// throws before that and nothing logs earlier.
let loggerInstance: Logger | null = null;
function logger(): Logger {
  if (!loggerInstance) throw new Error('logger used before app ready');
  return loggerInstance;
}

// The printer host[:port] the control view connected to — the only host the
// webview guest may navigate within (docs/security-audit-2026-08-17.md).
let allowedPrinterHost: string | null = null;

// Adapter manifests are data files shipped in the bundle (design doc §4);
// app.getAppPath() is the project root in dev/e2e and the asar root when
// packaged (adapters/** is included in electron-builder.yml files).
const adaptersDir = path.join(app.getAppPath(), 'adapters');
let cachedManifests: AdapterManifest[] | null = null;
async function adapterManifests(): Promise<AdapterManifest[]> {
  cachedManifests ??= await loadAdapterManifests(adaptersDir);
  return cachedManifests;
}

// Env override keeps e2e scans deterministic; otherwise the setting wins.
const envScanWindowMs = Number.parseInt(process.env.PRINTPILOT_SCAN_WINDOW_MS ?? '', 10) || undefined;

/**
 * Developer debug menu (design doc §7): dev/unpackaged builds only.
 * PRINTPILOT_DEBUG_MENU=1 force-enables it; PRINTPILOT_SIMULATE_PACKAGED=1
 * simulates a packaged build so e2e can assert the menu is absent.
 */
function debugMenuEnabled(): boolean {
  if (process.env.PRINTPILOT_DEBUG_MENU === '1') return true;
  if (process.env.PRINTPILOT_SIMULATE_PACKAGED === '1') return false;
  return !app.isPackaged;
}

async function diagnosticsText(): Promise<string> {
  const [settings, profiles, manifests] = await Promise.all([
    loadSettings(configDir),
    profileStore.list(),
    adapterManifests(),
  ]);
  return buildDiagnostics({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    adapterIds: manifests.map((m) => m.id),
    settings,
    profiles,
    logTail: logger().recentLines(50),
  });
}

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
      webSecurity: true,
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

  // External links open in the system browser, never in the shell window —
  // and only http(s); other schemes (file:, custom protocols) are refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation(url, null);
    if (decision.action === 'external') void shell.openExternal(decision.url);
    else logger().warn('security', 'shell window.open blocked', { url });
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** ipcMain.handle wrapper: every handler failure lands in the log (redacted). */
function handle(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...(args as never[]));
    } catch (err) {
      logger().warn('ipc', `${channel} failed`, { err: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    }
  });
}

/**
 * Renderer/webview-guest log forwarding (design doc §5). Only warn/error are
 * accepted, messages are length-capped, and each sender is rate-limited so a
 * broken page can't flood the log file.
 */
const LOG_WRITE_LEVELS: readonly LogLevel[] = ['warn', 'error'];
const LOG_WRITE_LIMIT = 10;
const LOG_WRITE_WINDOW_MS = 10_000;
const logWriteTimestamps = new Map<number, number[]>();

function registerIpc(): void {
  handle('app:info', async () => {
    const profiles = await loadProfiles(configDir);
    const settings = await loadSettings(configDir);
    // Consumed here so the recovery notice is shown exactly once.
    const crash = consumeCrashFlag(loggerDir());
    return {
      version: app.getVersion(),
      platform: process.platform,
      configDir,
      profileCount: profiles.printers.length,
      scanWindowMs: envScanWindowMs ?? settings.discovery.scanWindowMs,
      debugMenu: debugMenuEnabled(),
      logFilePath: logger().filePath,
      recoveredFromCrash: crash !== null,
    };
  });

  // --- Settings (design doc §4/§7) ------------------------------------------
  handle('settings:get', () => loadSettings(configDir));
  handle('settings:update', (_event, patch: unknown) =>
    updateSettings(configDir, validateSettingsPatch(patch)),
  );

  // --- Logging (design doc §5) -----------------------------------------------
  handle('log:write', (event, entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('log entry must be an object');
    const raw = entry as Record<string, unknown>;
    const level = raw.level;
    if (typeof level !== 'string' || !LOG_WRITE_LEVELS.includes(level as LogLevel)) {
      throw new Error('log level must be warn or error');
    }
    const message = assertString(raw.message, 'message', 500);
    const now = Date.now();
    const seen = (logWriteTimestamps.get(event.sender.id) ?? []).filter(
      (ts) => now - ts < LOG_WRITE_WINDOW_MS,
    );
    if (seen.length >= LOG_WRITE_LIMIT) return; // silently drop the flood
    seen.push(now);
    logWriteTimestamps.set(event.sender.id, seen);
    logger().log(level as LogLevel, 'renderer', message);
  });
  handle('log:reveal', () => {
    shell.showItemInFolder(logger().filePath);
  });

  // --- Diagnostics (design doc §5: "copy diagnostics" button) ----------------
  handle('diagnostics:copy', async () => {
    clipboard.writeText(await diagnosticsText());
  });

  // --- Developer debug menu (dev builds only, design doc §7) -----------------
  handle('debug:open-devtools', (event) => {
    if (!debugMenuEnabled()) throw new Error('Debug menu is only available in dev builds');
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools({ mode: 'detach' });
  });
  handle('debug:dump-state', async () => {
    if (!debugMenuEnabled()) throw new Error('Debug menu is only available in dev builds');
    const [settings, profiles] = await Promise.all([loadSettings(configDir), profileStore.list()]);
    // Redacted: the credential blob is replaced by a boolean before it can
    // reach the clipboard.
    const redacted = profiles.map((p) => ({
      ...stripCredential(p),
      credential: p.credentialEnc ? 'saved' : 'none',
    }));
    clipboard.writeText(`${JSON.stringify({ settings, profiles: redacted }, null, 2)}\n`);
  });

  // --- Discovery (design doc §3) -------------------------------------------
  handle('discovery:start', () => {
    logger().info('discovery', 'scan started');
    discovery.stop();
    discovery.clear();
    discovery.start();
  });
  handle('discovery:stop', () => {
    logger().info('discovery', 'scan stopped');
    discovery.stop();
  });
  handle('discovery:check-manual', (_event, ip: unknown) => {
    const host = assertString(ip, 'ip', 64);
    if (!isValidIpv4(host)) throw new Error('Not a valid IPv4 address');
    return discovery.checkManualHost(host);
  });

  // --- Profiles (design doc §4). Secrets are never logged — ids/names only. --
  handle('profiles:list', async () => (await profileStore.list()).map(stripCredential));
  handle('profiles:add', async (_event, input: unknown) => {
    const profile = stripCredential(await profileStore.add(validateNewProfile(input)));
    logger().info('profiles', 'profile added', { id: profile?.id, nickname: profile?.nickname });
    return profile;
  });
  handle('profiles:remove', (_event, id: unknown) => {
    const profileId = assertString(id, 'id', 64);
    logger().info('profiles', 'profile removed', { id: profileId });
    return profileStore.remove(profileId);
  });
  handle('profiles:rename', async (_event, id: unknown, nickname: unknown) => {
    const profile = stripCredential(
      await profileStore.rename(assertString(id, 'id', 64), assertString(nickname, 'nickname', 80)),
    );
    logger().info('profiles', 'profile renamed', { id: profile?.id });
    return profile;
  });
  handle('profiles:set-credential', async (_event, id: unknown, secret: unknown) => {
    const value = assertString(secret, 'credential', 200);
    const profileId = assertString(id, 'id', 64);
    await profileStore.setCredential(profileId, value);
    logger().info('profiles', 'credential saved', { id: profileId });
  });
  handle('profiles:get-credential', (_event, id: unknown) =>
    profileStore.getCredential(assertString(id, 'id', 64)),
  );

  // --- Control view (design doc §3: embedded Remote UI) ---------------------
  handle('control:connect', async (_event, input: unknown) => {
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
    allowedPrinterHost = `${target.host}:${target.port}`;
    logger().info('control', 'connecting', {
      host: allowedPrinterHost,
      adapter: adapter.id,
      adapterMatched: matched,
    });
    return {
      url: `http://${target.host}:${target.port}/`,
      preloadUrl: pathToFileURL(path.join(__dirname, '../preload/webview.mjs')).href,
      adapter,
      adapterMatched: matched,
    };
  });

  handle('control:open-external', (_event, url: unknown) => {
    const value = assertString(url, 'url', 300);
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) URLs can be opened externally');
    }
    logger().info('control', 'opened in system browser', { url: value });
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
    logger().info('discovery', 'printer found', {
      host: printer.host,
      port: printer.port,
      hostname: printer.hostname,
      vendor: printer.vendor,
      model: printer.model,
      via: printer.via,
    });
    send('discovery:printer-found', printer);
  });
  discovery.onError((err) => {
    logger().warn('discovery', 'scan error', { err });
    send('discovery:error', err.message);
  });
}

/** Log dir: Electron's per-OS logs dir, overridable for tests (like the config dir). */
function loggerDir(): string {
  return process.env.PRINTPILOT_LOG_DIR ?? app.getPath('logs');
}

/**
 * Local-only crash capture (docs/decisions/no-telemetry.md): write the crash
 * to the rotating log and set the next-launch recovery flag. Nothing is sent
 * anywhere.
 */
function recordCrash(kind: CrashKind, details: CrashDetails): void {
  const entry = formatCrashEntry(kind, details);
  logger().error('crash', 'process exited abnormally', entry);
  markCrash(loggerDir(), entry);
}

function registerCrashCapture(): void {
  // PRINTPILOT_SIMULATE_CRASH lets the e2e suite exercise the recovery notice
  // without actually crashing a process.
  if (process.env.PRINTPILOT_SIMULATE_CRASH === '1') {
    recordCrash('render-process-gone', { reason: 'simulated (PRINTPILOT_SIMULATE_CRASH=1)' });
  }
  app.on('render-process-gone', (_event, _webContents, details) => {
    recordCrash('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  app.on('child-process-gone', (_event, details) => {
    recordCrash('child-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      processType: details.type,
    });
  });
  process.on('unhandledRejection', (reason) => {
    recordCrash('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    recordCrash('uncaughtException', { reason: err.message });
  });
}

/**
 * Security policy for embedded content (docs/security-audit-2026-08-17.md):
 * the webview guest may only navigate within the printer host; other http(s)
 * URLs go to the system browser; everything else is denied. All Chromium
 * permission requests are denied — the app needs none of them.
 */
function registerSecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const grant = permissionDecision(permission);
    if (!grant) logger().warn('security', 'permission request denied', { permission });
    callback(grant);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permissionDecision(permission));

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideNavigation(url, allowedPrinterHost);
      if (decision.action === 'external') {
        logger().info('security', 'window.open routed to system browser', { url });
        void shell.openExternal(decision.url);
      } else {
        logger().warn('security', 'window.open blocked', { url });
      }
      return { action: 'deny' }; // popups never open inside the app
    });
    contents.on('will-navigate', (event, url) => {
      const decision = decideNavigation(url, allowedPrinterHost);
      if (decision.action === 'allow') return;
      event.preventDefault();
      if (decision.action === 'external') {
        logger().info('security', 'navigation routed to system browser', { url });
        void shell.openExternal(decision.url);
      } else {
        logger().warn('security', 'navigation blocked', { url, reason: decision.reason });
      }
    });
  });
}

void app.whenReady().then(() => {
  loggerInstance = createLogger({ dir: loggerDir() });
  logger().info('app', 'PrintPilot starting', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  registerCrashCapture();
  registerSecurityPolicy();
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
