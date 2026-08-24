import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CONFIG_VERSION,
  loadVersionedJson,
  saveVersionedJson,
  type MigrationTable,
} from './config-dir';

/**
 * Printer profile store (design doc §4): CRUD over profiles.json plus
 * credential handling. The store stays free of Electron imports — the
 * CredentialCipher is injected (src/main/credentials.ts supplies the
 * safeStorage-backed implementation) so Vitest exercises everything here.
 */

export interface PrinterProfile {
  id: string;
  nickname: string;
  host: string;
  vendor: string; // e.g. 'canon'
  model: string; // e.g. 'MF750'
  adapter: string; // adapter manifest id, e.g. 'canon-mf750'
  /**
   * Base64 safeStorage-encrypted credential blob. Design doc §4 mechanism:
   * safeStorage IS the OS-keychain-backed store (DPAPI on Windows,
   * libsecret/kwallet on Linux), so the blob lives here next to the profile
   * it belongs to. Never plaintext.
   */
  credentialEnc?: string;
  lastConnected?: string; // ISO 8601
}

export interface NewProfile {
  nickname: string;
  host: string;
  vendor: string;
  model: string;
  adapter: string;
}

export interface ProfilesFile {
  version: number;
  printers: PrinterProfile[];
}

/** Symmetric encrypt/decrypt for profile credentials (base64 in/out). */
export interface CredentialCipher {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

export class CredentialError extends Error {}

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
  // saveVersionedJson writes tmp + rename — a crash can't corrupt profiles.json.
  await saveVersionedJson(profilesPath(configDir), file);
}

export class ProfileStore {
  constructor(
    private configDir: string,
    private cipher?: CredentialCipher,
  ) {}

  async list(): Promise<PrinterProfile[]> {
    return (await loadProfiles(this.configDir)).printers;
  }

  async add(input: NewProfile): Promise<PrinterProfile> {
    const file = await loadProfiles(this.configDir);
    // One profile per host: re-adding an existing host refreshes it instead
    // of duplicating (docs/audit-2026-08-24.md). The id and any saved
    // credential survive the refresh.
    const existing = file.printers.find((p) => p.host === input.host);
    if (existing) {
      Object.assign(existing, input);
      await saveProfiles(this.configDir, file);
      return existing;
    }
    const profile: PrinterProfile = { id: randomUUID(), ...input };
    file.printers.push(profile);
    await saveProfiles(this.configDir, file);
    return profile;
  }

  async remove(id: string): Promise<boolean> {
    const file = await loadProfiles(this.configDir);
    const kept = file.printers.filter((p) => p.id !== id);
    if (kept.length === file.printers.length) return false;
    await saveProfiles(this.configDir, { ...file, printers: kept });
    return true;
  }

  async rename(id: string, nickname: string): Promise<PrinterProfile | null> {
    return this.mutate(id, (p) => {
      p.nickname = nickname;
    });
  }

  async touchLastConnected(id: string, when: Date = new Date()): Promise<PrinterProfile | null> {
    return this.mutate(id, (p) => {
      p.lastConnected = when.toISOString();
    });
  }

  async setCredential(id: string, plain: string): Promise<void> {
    const cipher = this.requireCipher();
    const updated = await this.mutate(id, (p) => {
      p.credentialEnc = cipher.encrypt(plain);
    });
    if (!updated) throw new CredentialError(`No profile with id ${id}`);
  }

  private requireCipher(): CredentialCipher {
    if (!this.cipher) {
      throw new CredentialError('OS keychain encryption is not available on this system');
    }
    return this.cipher;
  }

  private async mutate(
    id: string,
    change: (profile: PrinterProfile) => void,
  ): Promise<PrinterProfile | null> {
    const file = await loadProfiles(this.configDir);
    const profile = file.printers.find((p) => p.id === id);
    if (!profile) return null;
    change(profile);
    await saveProfiles(this.configDir, file);
    return profile;
  }
}
