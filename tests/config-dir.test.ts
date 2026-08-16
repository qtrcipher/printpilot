import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigFileError,
  loadVersionedJson,
  resolveConfigDir,
  runMigrations,
  saveVersionedJson,
  type Migration,
} from '../src/main/config-dir';
import { loadProfiles, profilesPath, saveProfiles } from '../src/main/profiles';
import { defaultSettings, loadSettings, saveSettings, settingsPath, SETTINGS_VERSION } from '../src/main/settings';

describe('resolveConfigDir', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      resolveConfigDir({ platform: 'win32', homeDir: 'C:\\Users\\a', appData: 'C:\\Users\\a\\AppData\\Roaming' }),
    ).toBe(path.join('C:\\Users\\a\\AppData\\Roaming', 'PrintPilot'));
  });

  it('falls back to ~/AppData/Roaming on Windows without %APPDATA%', () => {
    expect(resolveConfigDir({ platform: 'win32', homeDir: 'C:\\Users\\a' })).toBe(
      path.join('C:\\Users\\a', 'AppData', 'Roaming', 'PrintPilot'),
    );
  });

  it('uses $XDG_CONFIG_HOME on Linux', () => {
    expect(
      resolveConfigDir({ platform: 'linux', homeDir: '/home/a', xdgConfigHome: '/xdg' }),
    ).toBe(path.join('/xdg', 'printpilot'));
  });

  it('falls back to ~/.config on Linux without $XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ platform: 'linux', homeDir: '/home/a' })).toBe(
      path.join('/home/a', '.config', 'printpilot'),
    );
  });
});

describe('runMigrations', () => {
  it('returns data unchanged when already at target version', () => {
    const data = { version: 1, printers: [] };
    expect(runMigrations(data, 1, 1, new Map())).toBe(data);
  });

  it('applies the migration chain in order', () => {
    const migrations = new Map<number, Migration>([
      [1, (d) => ({ ...d, mid: true })],
      [2, (d) => ({ ...d, done: true })],
    ]);
    expect(runMigrations({ version: 1 }, 1, 3, migrations)).toEqual({
      version: 1,
      mid: true,
      done: true,
    });
  });

  it('rejects files newer than the app supports', () => {
    expect(() => runMigrations({ version: 99 }, 99, 1, new Map())).toThrow(ConfigFileError);
  });

  it('rejects a missing chain link instead of guessing', () => {
    expect(() => runMigrations({ version: 1 }, 1, 3, new Map())).toThrow(/Missing migration/);
  });

  it('rejects non-positive versions', () => {
    expect(() => runMigrations({}, 0, 1, new Map())).toThrow(ConfigFileError);
  });
});

describe('versioned JSON load/save', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'printpilot-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults stamped with the current version when the file is missing', async () => {
    const settings = await loadSettings(dir);
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings).toEqual({ ...defaultSettings(), version: SETTINGS_VERSION });
  });

  it('round-trips a saved file byte-for-byte through load', async () => {
    const settings = { ...defaultSettings(), version: SETTINGS_VERSION, keyboardScheme: 'vim' as const };
    await saveSettings(dir, settings);
    expect(await loadSettings(dir)).toEqual(settings);
    // Version field is actually on disk, not just in memory.
    const onDisk = JSON.parse(await readFile(settingsPath(dir), 'utf8')) as { version: number };
    expect(onDisk.version).toBe(SETTINGS_VERSION);
  });

  it('creates the config dir recursively on save', async () => {
    const nested = path.join(dir, 'deep', 'config');
    await saveProfiles(nested, { version: 1, printers: [] });
    expect(await loadProfiles(nested)).toEqual({ version: 1, printers: [] });
  });

  it('runs migrations on load and stamps the target version', async () => {
    await writeFile(profilesPath(dir), JSON.stringify({ version: 1, printers: [] }));
    const migrated = await loadVersionedJson<{ printers: unknown[]; tagged?: boolean }>(
      profilesPath(dir),
      {
        defaults: () => ({ printers: [] }),
        version: 2,
        migrations: new Map([[1, (d) => ({ ...d, tagged: true })]]),
      },
    );
    expect(migrated.version).toBe(2);
    expect(migrated.tagged).toBe(true);
  });

  it('throws on corrupt JSON instead of silently resetting', async () => {
    await writeFile(profilesPath(dir), '{not json');
    await expect(loadProfiles(dir)).rejects.toThrow(ConfigFileError);
  });

  it('throws on a file written by a newer app version', async () => {
    await writeFile(profilesPath(dir), JSON.stringify({ version: 99, printers: [] }));
    await expect(loadProfiles(dir)).rejects.toThrow(/newer than supported/);
  });
});
