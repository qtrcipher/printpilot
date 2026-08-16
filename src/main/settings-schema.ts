import type { MigrationTable } from './config-dir';

/**
 * Settings schema (design doc §4): types, defaults, gamepad bindings,
 * sanitization, patch validation, and migrations. Kept free of node-builtin
 * imports so the renderer and webview preload bundle the same code (the
 * fs-backed store lives in settings.ts; same split as adapters.ts vs
 * adapters-load.ts).
 *
 * v1 → v2: v1 shipped only { gamepad: { activate, back } } as raw button
 * indices; v2 adds theme/discovery.scanWindowMs/onboardingSeen and switches
 * gamepad mappings to sparse per-action bindings (buttons, axes, or keys).
 */

export class SettingsValidationError extends Error {}

/** Actions the gamepad/nav layer can be remapped for (design doc §7). */
export type GamepadAction = 'up' | 'down' | 'left' | 'right' | 'activate' | 'back';

export const GAMEPAD_ACTIONS: readonly GamepadAction[] = [
  'up',
  'down',
  'left',
  'right',
  'activate',
  'back',
];

/** A binding captured by press-to-assign: a gamepad button, stick direction, or keyboard key. */
export type GamepadBinding =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; axis: number; sign: 1 | -1 }
  | { kind: 'key'; key: string };

/** Fully-resolved mapping: every action has a binding. */
export type GamepadMapping = Record<GamepadAction, GamepadBinding>;

export const DEFAULT_GAMEPAD_MAPPING: GamepadMapping = {
  up: { kind: 'axis', axis: 1, sign: -1 },
  down: { kind: 'axis', axis: 1, sign: 1 },
  left: { kind: 'axis', axis: 0, sign: -1 },
  right: { kind: 'axis', axis: 0, sign: 1 },
  activate: { kind: 'button', index: 0 }, // A / cross
  back: { kind: 'button', index: 1 }, // B / circle
};

export function isGamepadBinding(value: unknown): value is GamepadBinding {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case 'button':
      return typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 0 && raw.index < 64;
    case 'axis':
      return (
        typeof raw.axis === 'number' &&
        Number.isInteger(raw.axis) &&
        raw.axis >= 0 &&
        raw.axis < 16 &&
        (raw.sign === 1 || raw.sign === -1)
      );
    case 'key':
      return typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= 32;
    default:
      return false;
  }
}

/**
 * Merge saved per-action overrides over the defaults. Invalid or missing
 * entries fall back to the default binding for that action (never throws —
 * a corrupt mapping must not break navigation).
 */
export function resolveGamepadMapping(
  saved?: Partial<Record<GamepadAction, GamepadBinding | unknown>>,
): GamepadMapping {
  const resolved = { ...DEFAULT_GAMEPAD_MAPPING };
  if (!saved) return resolved;
  for (const action of GAMEPAD_ACTIONS) {
    const binding = saved[action];
    if (isGamepadBinding(binding)) resolved[action] = binding;
  }
  return resolved;
}

/** Human-readable binding label for the remap UI. */
export function describeBinding(binding: GamepadBinding): string {
  switch (binding.kind) {
    case 'button':
      return `Button ${binding.index}`;
    case 'axis':
      return `Axis ${binding.axis} ${binding.sign > 0 ? '+' : '−'}`;
    case 'key':
      return `Key “${binding.key}”`;
  }
}

export type ThemeSetting = 'dark' | 'light' | 'system';

export interface WindowState {
  width: number;
  height: number;
  maximized: boolean;
}

export interface SettingsFile {
  version: number;
  theme: ThemeSetting;
  /** Sparse: only actions the user remapped; defaults fill the rest. */
  gamepad: Partial<Record<GamepadAction, GamepadBinding>>;
  keyboardScheme: 'arrows' | 'vim';
  window: WindowState;
  discovery: {
    mdnsEnabled: boolean;
    snmpEnabled: boolean;
    scanWindowMs: number;
  };
  /** First-run welcome shown until dismissed (design doc §7). */
  onboardingSeen: boolean;
}

export const SETTINGS_VERSION = 2;

/**
 * v1 → v2: convert { activate, back } button indices to bindings, default
 * the new fields. Existing users count as onboarded (the welcome screen did
 * not exist when they first ran the app).
 */
export const SETTINGS_MIGRATIONS: MigrationTable = new Map([
  [
    1,
    (data) => {
      const { gamepad: oldGamepad, ...rest } = data;
      const old = (typeof oldGamepad === 'object' && oldGamepad !== null ? oldGamepad : {}) as Record<
        string,
        unknown
      >;
      const gamepad: Partial<Record<GamepadAction, GamepadBinding>> = {};
      for (const action of ['activate', 'back'] as const) {
        const index = old[action];
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
          gamepad[action] = { kind: 'button', index };
        }
      }
      return { ...rest, gamepad, onboardingSeen: true };
    },
  ],
]);

export function defaultSettings(): Omit<SettingsFile, 'version'> {
  return {
    theme: 'system', // OS preference wins; dark when the OS expresses none
    gamepad: {},
    keyboardScheme: 'arrows',
    window: { width: 1024, height: 720, maximized: false },
    discovery: { mdnsEnabled: true, snmpEnabled: true, scanWindowMs: 5000 },
    onboardingSeen: false,
  };
}

function fail(field: string): never {
  throw new SettingsValidationError(`settings.json: invalid value for "${field}"`);
}

function sanitizeWindow(value: unknown): WindowState {
  if (value === undefined) return defaultSettings().window;
  if (typeof value !== 'object' || value === null) fail('window');
  const raw = value as Record<string, unknown>;
  const { width, height, maximized } = raw;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width < 320 ||
    height < 240 ||
    typeof maximized !== 'boolean'
  ) {
    fail('window');
  }
  return { width, height, maximized };
}

function sanitizeGamepad(value: unknown): Partial<Record<GamepadAction, GamepadBinding>> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('gamepad');
  const raw = value as Record<string, unknown>;
  const gamepad: Partial<Record<GamepadAction, GamepadBinding>> = {};
  for (const [action, binding] of Object.entries(raw)) {
    if (!(GAMEPAD_ACTIONS as readonly string[]).includes(action) || !isGamepadBinding(binding)) {
      fail(`gamepad.${action}`);
    }
    gamepad[action as GamepadAction] = binding;
  }
  return gamepad;
}

function sanitizeDiscovery(value: unknown): SettingsFile['discovery'] {
  if (value === undefined) return defaultSettings().discovery;
  if (typeof value !== 'object' || value === null) fail('discovery');
  const raw = value as Record<string, unknown>;
  const { mdnsEnabled, snmpEnabled, scanWindowMs } = raw;
  if (typeof mdnsEnabled !== 'boolean' || typeof snmpEnabled !== 'boolean') fail('discovery');
  if (
    scanWindowMs !== undefined &&
    (typeof scanWindowMs !== 'number' ||
      !Number.isInteger(scanWindowMs) ||
      scanWindowMs < 500 ||
      scanWindowMs > 60_000)
  ) {
    fail('discovery.scanWindowMs');
  }
  return {
    mdnsEnabled,
    snmpEnabled,
    scanWindowMs: scanWindowMs ?? defaultSettings().discovery.scanWindowMs,
  };
}

/**
 * Validate a parsed settings file body, filling defaults for fields the
 * file doesn't have (older/minimal files stay loadable) and rejecting
 * present-but-wrong-typed values (garbage never silently wins).
 */
export function sanitizeSettings(data: Record<string, unknown>): Omit<SettingsFile, 'version'> {
  const defaults = defaultSettings();
  const { theme, keyboardScheme, onboardingSeen } = data;
  if (theme !== undefined && theme !== 'dark' && theme !== 'light' && theme !== 'system') {
    fail('theme');
  }
  if (keyboardScheme !== undefined && keyboardScheme !== 'arrows' && keyboardScheme !== 'vim') {
    fail('keyboardScheme');
  }
  if (onboardingSeen !== undefined && typeof onboardingSeen !== 'boolean') {
    fail('onboardingSeen');
  }
  return {
    theme: theme ?? defaults.theme,
    gamepad: sanitizeGamepad(data.gamepad),
    keyboardScheme: keyboardScheme ?? defaults.keyboardScheme,
    window: sanitizeWindow(data.window),
    discovery: sanitizeDiscovery(data.discovery),
    onboardingSeen: onboardingSeen ?? defaults.onboardingSeen,
  };
}

/** Validated partial update accepted over IPC (settings:update). */
export interface SettingsPatch {
  theme?: ThemeSetting;
  gamepad?: Partial<Record<GamepadAction, GamepadBinding>>;
  discovery?: { scanWindowMs?: number };
  onboardingSeen?: boolean;
}

export function validateSettingsPatch(input: unknown): SettingsPatch {
  if (typeof input !== 'object' || input === null) throw new Error('settings patch must be an object');
  const raw = input as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (raw.theme !== undefined) {
    if (raw.theme !== 'dark' && raw.theme !== 'light' && raw.theme !== 'system') {
      throw new Error('theme must be dark, light, or system');
    }
    patch.theme = raw.theme;
  }
  if (raw.gamepad !== undefined) {
    patch.gamepad = sanitizeGamepad(raw.gamepad); // throws SettingsValidationError on garbage
  }
  if (raw.discovery !== undefined) {
    if (typeof raw.discovery !== 'object' || raw.discovery === null) {
      throw new Error('discovery must be an object');
    }
    const { scanWindowMs } = raw.discovery as Record<string, unknown>;
    if (scanWindowMs !== undefined) {
      if (
        typeof scanWindowMs !== 'number' ||
        !Number.isInteger(scanWindowMs) ||
        scanWindowMs < 500 ||
        scanWindowMs > 60_000
      ) {
        throw new Error('scanWindowMs must be an integer between 500 and 60000');
      }
      patch.discovery = { scanWindowMs };
    }
  }
  if (raw.onboardingSeen !== undefined) {
    if (typeof raw.onboardingSeen !== 'boolean') throw new Error('onboardingSeen must be a boolean');
    patch.onboardingSeen = raw.onboardingSeen;
  }
  return patch;
}
