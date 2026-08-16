import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal typed bridge between main and the shell renderer.
 * The control-webview preload (nav-layer injection) is a separate Phase 2
 * preload; this one only serves the shell UI.
 */

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  configDir: string;
  profileCount: number;
}

export interface PrintPilotBridge {
  getAppInfo(): Promise<AppInfo>;
}

const bridge: PrintPilotBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
};

contextBridge.exposeInMainWorld('printpilot', bridge);
