import path from 'node:path';
import {
  CONFIG_VERSION,
  loadVersionedJson,
  saveVersionedJson,
  type MigrationTable,
} from './config-dir';

/**
 * Settings store (design doc §4): gamepad mappings, keyboard scheme, window
 * state, discovery prefs. Versioned; migration runner runs on startup.
 *
 * Phase 1: typed stub with defaults only — remap UI and prefs screens are
 * Phase 2.
 */

export interface GamepadMapping {
  /** Logical action -> gamepad button index (Chromium Gamepad API). */
  activate: number; // default 0 (A / cross)
  back: number; // default 1 (B / circle)
}

export interface WindowState {
  width: number;
  height: number;
  maximized: boolean;
}

export interface SettingsFile {
  version: number;
  gamepad: GamepadMapping;
  keyboardScheme: 'arrows' | 'vim';
  window: WindowState;
  discovery: {
    mdnsEnabled: boolean;
    snmpEnabled: boolean;
  };
}

export const SETTINGS_VERSION = CONFIG_VERSION; // 1

/** No migrations yet — v1 is the first schema. */
export const SETTINGS_MIGRATIONS: MigrationTable = new Map();

export function defaultSettings(): Omit<SettingsFile, 'version'> {
  return {
    gamepad: { activate: 0, back: 1 },
    keyboardScheme: 'arrows',
    window: { width: 1024, height: 720, maximized: false },
    discovery: { mdnsEnabled: true, snmpEnabled: true },
  };
}

export function settingsPath(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

export async function loadSettings(configDir: string): Promise<SettingsFile> {
  return loadVersionedJson<Omit<SettingsFile, 'version'>>(settingsPath(configDir), {
    defaults: defaultSettings,
    version: SETTINGS_VERSION,
    migrations: SETTINGS_MIGRATIONS,
  });
}

export async function saveSettings(configDir: string, file: SettingsFile): Promise<void> {
  // TODO(Phase 2): called from IPC handlers once the settings screen exists.
  await saveVersionedJson(settingsPath(configDir), file);
}
