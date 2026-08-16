import { contextBridge, ipcRenderer } from 'electron';
import type { AdapterManifest } from '../main/adapters';
import type { DiscoveredPrinter, ManualCheckResult } from '../main/discovery';
import type { PrinterProfile } from '../main/profiles';
import type { SettingsFile, SettingsPatch } from '../main/settings-schema';

/**
 * Typed bridge between main and the shell renderer.
 * The control-webview preload (src/preload/webview.ts) is a separate preload
 * injected into the embedded Remote UI page; this one only serves the shell.
 */

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  configDir: string;
  profileCount: number;
  /** How long the Home scan window stays in the loading state. */
  scanWindowMs: number;
  /** Developer debug menu available (dev/unpackaged builds only). */
  debugMenu: boolean;
  /** Rotating log file (design doc §5) — shown in Settings. */
  logFilePath: string;
  /** Previous run ended in a crash; show the recovery notice once. */
  recoveredFromCrash: boolean;
}

/** Profile as the renderer sees it — the credential blob never crosses over. */
export type PublicProfile = Omit<PrinterProfile, 'credentialEnc'>;

export interface NewProfileInput {
  nickname: string;
  host: string;
  vendor: string;
  model: string;
  adapter: string;
}

/** A printer the control view should connect to (profile or discovered). */
export interface ConnectTargetInput {
  nickname: string;
  host: string;
  port?: number;
  vendor?: string;
  model?: string;
  adapter?: string;
  /** Saved profile id — enables the credential offer + lastConnected. */
  profileId?: string;
}

export interface ConnectResult {
  /** Remote UI root URL to load in the webview. */
  url: string;
  /** file:// URL of the guest nav-layer preload. */
  preloadUrl: string;
  adapter: AdapterManifest;
  /** false = unknown layout; generic focus ring, still usable (design §5). */
  adapterMatched: boolean;
}

export interface PrintPilotBridge {
  getAppInfo(): Promise<AppInfo>;

  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  /** Returns an unsubscribe function. */
  onPrinterFound(cb: (printer: DiscoveredPrinter) => void): () => void;
  onDiscoveryError(cb: (message: string) => void): () => void;
  checkManualHost(ip: string): Promise<ManualCheckResult>;

  listProfiles(): Promise<PublicProfile[]>;
  addProfile(input: NewProfileInput): Promise<PublicProfile>;
  removeProfile(id: string): Promise<boolean>;
  renameProfile(id: string, nickname: string): Promise<PublicProfile | null>;
  setProfileCredential(id: string, secret: string): Promise<void>;
  getProfileCredential(id: string): Promise<string | null>;

  connectPrinter(target: ConnectTargetInput): Promise<ConnectResult>;
  openExternal(url: string): Promise<void>;

  getSettings(): Promise<SettingsFile>;
  updateSettings(patch: SettingsPatch): Promise<SettingsFile>;

  /** Assembles the diagnostics text in main and puts it on the clipboard. */
  copyDiagnostics(): Promise<void>;

  /** Forward a warn/error line to the rotating log (rate-limited in main). */
  writeLog(level: 'warn' | 'error', message: string): Promise<void>;
  /** Reveal the log file in the OS file manager. */
  revealLogFile(): Promise<void>;

  /** Dev builds only — main throws when the debug menu is disabled. */
  debugOpenDevTools(): Promise<void>;
  debugDumpState(): Promise<void>;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: PrintPilotBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,

  startDiscovery: () => ipcRenderer.invoke('discovery:start') as Promise<void>,
  stopDiscovery: () => ipcRenderer.invoke('discovery:stop') as Promise<void>,
  onPrinterFound: (cb) => subscribe('discovery:printer-found', cb),
  onDiscoveryError: (cb) => subscribe('discovery:error', cb),
  checkManualHost: (ip) => ipcRenderer.invoke('discovery:check-manual', ip) as Promise<ManualCheckResult>,

  listProfiles: () => ipcRenderer.invoke('profiles:list') as Promise<PublicProfile[]>,
  addProfile: (input) => ipcRenderer.invoke('profiles:add', input) as Promise<PublicProfile>,
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id) as Promise<boolean>,
  renameProfile: (id, nickname) =>
    ipcRenderer.invoke('profiles:rename', id, nickname) as Promise<PublicProfile | null>,
  setProfileCredential: (id, secret) =>
    ipcRenderer.invoke('profiles:set-credential', id, secret) as Promise<void>,
  getProfileCredential: (id) =>
    ipcRenderer.invoke('profiles:get-credential', id) as Promise<string | null>,

  connectPrinter: (target) => ipcRenderer.invoke('control:connect', target) as Promise<ConnectResult>,
  openExternal: (url) => ipcRenderer.invoke('control:open-external', url) as Promise<void>,

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<SettingsFile>,
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<SettingsFile>,

  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy') as Promise<void>,

  writeLog: (level, message) => ipcRenderer.invoke('log:write', { level, message }) as Promise<void>,
  revealLogFile: () => ipcRenderer.invoke('log:reveal') as Promise<void>,

  debugOpenDevTools: () => ipcRenderer.invoke('debug:open-devtools') as Promise<void>,
  debugDumpState: () => ipcRenderer.invoke('debug:dump-state') as Promise<void>,
};

contextBridge.exposeInMainWorld('printpilot', bridge);
