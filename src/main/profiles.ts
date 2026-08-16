import path from 'node:path';
import {
  CONFIG_VERSION,
  loadVersionedJson,
  saveVersionedJson,
  type MigrationTable,
} from './config-dir';

/**
 * Printer profile store (design doc §4).
 *
 * Phase 1: typed stub only — the schema is final, the IPC wiring and
 * credential storage (safeStorage / OS keychain) land in Phase 2.
 */

export interface PrinterProfile {
  id: string;
  nickname: string;
  host: string;
  vendor: string; // e.g. 'canon'
  model: string; // e.g. 'MF750'
  adapter: string; // adapter manifest id, e.g. 'canon-mf750'
  /** Reference to an OS keychain entry — never the credential itself. */
  credentialId?: string;
  lastConnected?: string; // ISO 8601
}

export interface ProfilesFile {
  version: number;
  printers: PrinterProfile[];
}

export const PROFILES_VERSION = CONFIG_VERSION; // 1

/** No migrations yet — v1 is the first schema. */
export const PROFILE_MIGRATIONS: MigrationTable = new Map();

export function defaultProfiles(): Omit<ProfilesFile, 'version'> {
  return { printers: [] };
}

export function profilesPath(configDir: string): string {
  return path.join(configDir, 'profiles.json');
}

export async function loadProfiles(configDir: string): Promise<ProfilesFile> {
  return loadVersionedJson<Omit<ProfilesFile, 'version'>>(profilesPath(configDir), {
    defaults: defaultProfiles,
    version: PROFILES_VERSION,
    migrations: PROFILE_MIGRATIONS,
  });
}

export async function saveProfiles(configDir: string, file: ProfilesFile): Promise<void> {
  // TODO(Phase 2): called from IPC handlers once profile CRUD exists.
  await saveVersionedJson(profilesPath(configDir), file);
}
