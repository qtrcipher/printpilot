import path from 'node:path';
import { loadVersionedJson, saveVersionedJson } from './config-dir';
import {
  sanitizeSettings,
  SETTINGS_MIGRATIONS,
  SETTINGS_VERSION,
  type SettingsFile,
  type SettingsPatch,
} from './settings-schema';

/**
 * fs-backed settings store (design doc §4). The schema, defaults,
 * sanitization, and migrations live in settings-schema.ts (node-free so the
 * renderer bundles them); this module adds persistence — versioned load,
 * atomic tmp+rename save, and patch-based update. Same split as
 * profiles.ts vs the pure stores.
 */

export * from './settings-schema';

export function settingsPath(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

export async function loadSettings(configDir: string): Promise<SettingsFile> {
  const raw = await loadVersionedJson<Record<string, unknown>>(settingsPath(configDir), {
    defaults: () => ({}),
    version: SETTINGS_VERSION,
    migrations: SETTINGS_MIGRATIONS,
  });
  return { ...sanitizeSettings(raw), version: SETTINGS_VERSION };
}

export async function saveSettings(configDir: string, file: SettingsFile): Promise<void> {
  // saveVersionedJson writes tmp + rename — a crash can't corrupt settings.json.
  await saveVersionedJson(settingsPath(configDir), file);
}

/** Load → apply a validated patch → save → return the updated settings. */
export async function updateSettings(configDir: string, patch: SettingsPatch): Promise<SettingsFile> {
  const current = await loadSettings(configDir);
  const next: SettingsFile = {
    ...current,
    theme: patch.theme ?? current.theme,
    gamepad: patch.gamepad ?? current.gamepad,
    discovery: {
      ...current.discovery,
      scanWindowMs: patch.discovery?.scanWindowMs ?? current.discovery.scanWindowMs,
    },
    onboardingSeen: patch.onboardingSeen ?? current.onboardingSeen,
  };
  await saveSettings(configDir, next);
  return next;
}
