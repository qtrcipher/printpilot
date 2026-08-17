import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsValidationError } from '../src/main/settings-schema';
import {
  DEFAULT_GAMEPAD_MAPPING,
  defaultSettings,
  isGamepadBinding,
  loadSettings,
  resolveGamepadMapping,
  sanitizeSettings,
  saveSettings,
  SETTINGS_VERSION,
  settingsPath,
  updateSettings,
  validateSettingsPatch,
} from '../src/main/settings';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'printpilot-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('settings store', () => {
  it('returns v2 defaults for a missing file (onboarding not yet seen)', async () => {
    const settings = await loadSettings(dir);
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.theme).toBe('system');
    expect(settings.gamepad).toEqual({});
    expect(settings.discovery.scanWindowMs).toBe(5000);
    expect(settings.onboardingSeen).toBe(false);
  });

  it('migrates a v1 file: button indices become bindings, user counts as onboarded', async () => {
    await writeFile(
      settingsPath(dir),
      JSON.stringify({
        version: 1,
        gamepad: { activate: 2, back: 3 },
        keyboardScheme: 'arrows',
        window: { width: 1024, height: 720, maximized: false },
        discovery: { mdnsEnabled: true, snmpEnabled: true },
      }),
    );
    const settings = await loadSettings(dir);
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.gamepad).toEqual({
      activate: { kind: 'button', index: 2 },
      back: { kind: 'button', index: 3 },
    });
    expect(settings.onboardingSeen).toBe(true);
    expect(settings.theme).toBe('system'); // new field defaulted
  });

  it('writes atomically: no .tmp file is left behind after save', async () => {
    await saveSettings(dir, { ...defaultSettings(), version: SETTINGS_VERSION });
    const files = await readdir(dir);
    expect(files).toEqual(['settings.json']);
    const onDisk = JSON.parse(await readFile(settingsPath(dir), 'utf8')) as { version: number };
    expect(onDisk.version).toBe(SETTINGS_VERSION);
  });

  it('rejects garbage values instead of silently keeping them', async () => {
    await writeFile(
      settingsPath(dir),
      JSON.stringify({ version: 2, theme: 42, discovery: { mdnsEnabled: true, snmpEnabled: true } }),
    );
    await expect(loadSettings(dir)).rejects.toThrow(SettingsValidationError);
  });

  it('fills defaults for fields a minimal file does not have', async () => {
    await writeFile(settingsPath(dir), JSON.stringify({ version: 2, onboardingSeen: true }));
    const settings = await loadSettings(dir);
    expect(settings).toEqual({ ...defaultSettings(), onboardingSeen: true, version: SETTINGS_VERSION });
  });

  it('sanitizeSettings rejects malformed gamepad bindings', () => {
    expect(() => sanitizeSettings({ gamepad: { activate: { kind: 'button', index: -1 } } })).toThrow(
      SettingsValidationError,
    );
    expect(() => sanitizeSettings({ gamepad: { jump: { kind: 'button', index: 1 } } })).toThrow(
      SettingsValidationError,
    );
    expect(() => sanitizeSettings({ gamepad: 'wasd' })).toThrow(SettingsValidationError);
  });

  it('updateSettings applies a validated patch and persists it', async () => {
    const updated = await updateSettings(dir, { theme: 'light', onboardingSeen: true });
    expect(updated.theme).toBe('light');
    expect(updated.onboardingSeen).toBe(true);
    expect((await loadSettings(dir)).theme).toBe('light');
  });

  it('validateSettingsPatch rejects bad input at the IPC boundary', () => {
    expect(() => validateSettingsPatch('theme=dark')).toThrow(/object/);
    expect(() => validateSettingsPatch({ theme: 'blue' })).toThrow(/theme/);
    expect(() => validateSettingsPatch({ discovery: { scanWindowMs: 10 } })).toThrow(/scanWindowMs/);
    expect(() => validateSettingsPatch({ onboardingSeen: 'yes' })).toThrow(/onboardingSeen/);
    expect(validateSettingsPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });
});

describe('resolveGamepadMapping', () => {
  it('returns the defaults when nothing is saved', () => {
    expect(resolveGamepadMapping(undefined)).toEqual(DEFAULT_GAMEPAD_MAPPING);
    expect(resolveGamepadMapping({})).toEqual(DEFAULT_GAMEPAD_MAPPING);
  });

  it('lets a custom binding override the default for that action only', () => {
    const resolved = resolveGamepadMapping({ activate: { kind: 'button', index: 7 } });
    expect(resolved.activate).toEqual({ kind: 'button', index: 7 });
    expect(resolved.back).toEqual(DEFAULT_GAMEPAD_MAPPING.back); // unmapped falls back
    expect(resolved.up).toEqual(DEFAULT_GAMEPAD_MAPPING.up);
  });

  it('drops invalid saved bindings instead of propagating them', () => {
    const resolved = resolveGamepadMapping({
      back: { kind: 'button', index: 'zero' },
      up: { kind: 'telepathy' },
    });
    expect(resolved.back).toEqual(DEFAULT_GAMEPAD_MAPPING.back);
    expect(resolved.up).toEqual(DEFAULT_GAMEPAD_MAPPING.up);
  });

  it('isGamepadBinding validates the three binding kinds', () => {
    expect(isGamepadBinding({ kind: 'button', index: 0 })).toBe(true);
    expect(isGamepadBinding({ kind: 'axis', axis: 1, sign: -1 })).toBe(true);
    expect(isGamepadBinding({ kind: 'key', key: ' ' })).toBe(true);
    expect(isGamepadBinding({ kind: 'axis', axis: 1, sign: 0 })).toBe(false);
    expect(isGamepadBinding({ kind: 'key', key: '' })).toBe(false);
    expect(isGamepadBinding(null)).toBe(false);
  });
});

describe('onboarding flag logic', () => {
  it('defaults to unseen on a fresh install, stays seen after dismiss persists', async () => {
    expect((await loadSettings(dir)).onboardingSeen).toBe(false);
    await updateSettings(dir, { onboardingSeen: true });
    expect((await loadSettings(dir)).onboardingSeen).toBe(true);
  });
});

describe('on-screen pad setting', () => {
  it('defaults to show and fills show for older files without the field', async () => {
    expect(defaultSettings().onScreenPad).toBe('show');
    await writeFile(settingsPath(dir), JSON.stringify({ version: 2, onboardingSeen: true }));
    expect((await loadSettings(dir)).onScreenPad).toBe('show');
  });

  it('rejects garbage values instead of silently keeping them', () => {
    expect(() => sanitizeSettings({ onScreenPad: 'auto' })).toThrow(SettingsValidationError);
    expect(() => sanitizeSettings({ onScreenPad: 1 })).toThrow(SettingsValidationError);
    expect(sanitizeSettings({ onScreenPad: 'hide' }).onScreenPad).toBe('hide');
  });

  it('persists show/hide via updateSettings and validates the patch at the IPC boundary', async () => {
    const updated = await updateSettings(dir, { onScreenPad: 'hide' });
    expect(updated.onScreenPad).toBe('hide');
    expect((await loadSettings(dir)).onScreenPad).toBe('hide');
    expect(() => validateSettingsPatch({ onScreenPad: 'sometimes' })).toThrow(/onScreenPad/);
    expect(validateSettingsPatch({ onScreenPad: 'show' })).toEqual({ onScreenPad: 'show' });
  });
});

describe('on-screen keyboard setting', () => {
  it('defaults to auto and fills auto for older files without the field', async () => {
    expect(defaultSettings().onScreenKeyboard).toBe('auto');
    await writeFile(settingsPath(dir), JSON.stringify({ version: 2, onboardingSeen: true }));
    expect((await loadSettings(dir)).onScreenKeyboard).toBe('auto');
  });

  it('rejects garbage values instead of silently keeping them', () => {
    expect(() => sanitizeSettings({ onScreenKeyboard: 'yes' })).toThrow(SettingsValidationError);
    expect(() => sanitizeSettings({ onScreenKeyboard: 0 })).toThrow(SettingsValidationError);
    expect(sanitizeSettings({ onScreenKeyboard: 'always' }).onScreenKeyboard).toBe('always');
    expect(sanitizeSettings({ onScreenKeyboard: 'never' }).onScreenKeyboard).toBe('never');
  });

  it('persists the mode via updateSettings and validates the patch at the IPC boundary', async () => {
    const updated = await updateSettings(dir, { onScreenKeyboard: 'never' });
    expect(updated.onScreenKeyboard).toBe('never');
    expect((await loadSettings(dir)).onScreenKeyboard).toBe('never');
    expect(() => validateSettingsPatch({ onScreenKeyboard: 'sometimes' })).toThrow(
      /onScreenKeyboard/,
    );
    expect(validateSettingsPatch({ onScreenKeyboard: 'auto' })).toEqual({
      onScreenKeyboard: 'auto',
    });
  });
});
