import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Config-dir resolution + versioned JSON persistence.
 *
 * Design doc §4: profiles.json / settings.json live in the OS config dir,
 * carry a `version` field (current = 1), and a tiny migration runner runs on
 * startup. Kept free of Electron imports so Vitest can exercise it directly;
 * src/main/index.ts supplies the real home/platform at runtime.
 */

export const APP_DIR_NAME = 'PrintPilot';
export const CONFIG_VERSION = 1;

/** A migration upgrades a parsed file body from version N to N + 1. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;
/** Key = version the migration upgrades FROM (migration at key 1 yields v2). */
export type MigrationTable = ReadonlyMap<number, Migration>;

export interface ResolveEnv {
  platform: NodeJS.Platform;
  homeDir: string;
  appData?: string | undefined; // %APPDATA% on Windows
  xdgConfigHome?: string | undefined; // $XDG_CONFIG_HOME on Linux
}

/**
 * OS config dir for the app.
 * - Windows: %APPDATA%/PrintPilot (fallback ~/AppData/Roaming/PrintPilot)
 * - Linux/other: $XDG_CONFIG_HOME/printpilot (fallback ~/.config/printpilot)
 */
export function resolveConfigDir(env: ResolveEnv): string {
  if (env.platform === 'win32') {
    const base = env.appData ?? path.join(env.homeDir, 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }
  const base = env.xdgConfigHome ?? path.join(env.homeDir, '.config');
  return path.join(base, APP_DIR_NAME.toLowerCase());
}

export class ConfigFileError extends Error {}

/**
 * Move an unreadable config file aside (`<file>.corrupt-<timestamp>`) so the
 * app can boot with defaults instead of crashing (docs/audit-2026-08-24.md —
 * a corrupt settings.json used to leave the app windowless). Returns the
 * quarantine path, or null when there was nothing to move.
 */
export async function quarantineCorruptFile(filePath: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${filePath}.corrupt-${stamp}`;
  try {
    await fs.rename(filePath, target);
    return target;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Upgrade `data` (currently at `fromVersion`) to `toVersion` by applying the
 * migration chain. Throws when the file is newer than the app understands or
 * a chain link is missing.
 */
export function runMigrations(
  data: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: MigrationTable,
): Record<string, unknown> {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new ConfigFileError(`Invalid config version: ${String(fromVersion)}`);
  }
  if (fromVersion > toVersion) {
    throw new ConfigFileError(
      `Config version ${fromVersion} is newer than supported version ${toVersion}`,
    );
  }
  let current = data;
  for (let v = fromVersion; v < toVersion; v += 1) {
    const step = migrations.get(v);
    if (!step) {
      throw new ConfigFileError(`Missing migration from version ${v} to ${v + 1}`);
    }
    current = step(current);
  }
  return current;
}

export interface VersionedStoreOptions<T> {
  /** File body used when the file does not exist yet (version is stamped on). */
  defaults: () => T;
  /** Current on-disk schema version written by this build. */
  version?: number;
  migrations?: MigrationTable;
}

/**
 * Load a versioned JSON file. Missing file → defaults stamped with the
 * current version. Older file → migrated in memory (the caller decides when
 * to persist). Newer/corrupt file → ConfigFileError, never silent data loss.
 */
export async function loadVersionedJson<T extends object>(
  filePath: string,
  options: VersionedStoreOptions<T>,
): Promise<T & { version: number }> {
  const targetVersion = options.version ?? CONFIG_VERSION;
  const migrations = options.migrations ?? new Map();

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...options.defaults(), version: targetVersion };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigFileError(`Config file is not valid JSON: ${filePath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(`Config file must contain a JSON object: ${filePath}`);
  }
  const body = parsed as Record<string, unknown>;
  const fileVersion = typeof body.version === 'number' ? body.version : 1;

  const migrated = runMigrations(body, fileVersion, targetVersion, migrations);
  return { ...migrated, version: targetVersion } as T & { version: number };
}

/** Persist a versioned JSON file (mkdir -p first, atomic-ish via rename). */
export async function saveVersionedJson<T extends object>(
  filePath: string,
  data: T & { version: number },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}
