import { contextBridge, ipcRenderer } from 'electron';
import type { DiscoveredPrinter, ManualCheckResult } from '../main/discovery';
import type { PrinterProfile } from '../main/profiles';

/**
 * Typed bridge between main and the shell renderer.
 * The control-webview preload (nav-layer injection) is a separate Phase 2
 * preload; this one only serves the shell UI.
 */

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  configDir: string;
  profileCount: number;
  /** How long the Home scan window stays in the loading state. */
  scanWindowMs: number;
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
};

contextBridge.exposeInMainWorld('printpilot', bridge);
