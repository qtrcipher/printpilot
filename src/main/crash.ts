import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Local-only crash capture (design doc §5; docs/decisions/no-telemetry.md):
 * crash details go to the rotating log, and a small flag file marks that the
 * previous run ended badly so the shell can show a recovery notice on next
 * launch. Nothing is sent anywhere — there is no remote endpoint.
 */

export type CrashKind =
  | 'render-process-gone'
  | 'child-process-gone'
  | 'unhandledRejection'
  | 'uncaughtException';

export interface CrashDetails {
  /** Electron's exit reason ('crashed', 'killed', 'oom', …) or a JS error. */
  reason: string;
  exitCode?: number;
  /** Process type for child-process-gone ('GPU', 'Utility', …). */
  processType?: string;
}

/** Log context for one crash event — bounded strings, no stack/secret data. */
export function formatCrashEntry(kind: CrashKind, details: CrashDetails): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    crashKind: kind,
    crashReason: String(details.reason).slice(0, 300),
  };
  if (details.exitCode !== undefined) entry.exitCode = details.exitCode;
  if (details.processType) entry.processType = details.processType.slice(0, 40);
  return entry;
}

/** One line shown in the shell's recovery notice context (and tests). */
export function describeCrash(entry: Record<string, unknown>): string {
  const kind = typeof entry.crashKind === 'string' ? entry.crashKind : 'crash';
  const reason = typeof entry.crashReason === 'string' ? entry.crashReason : 'unknown';
  return `${kind}: ${reason}`;
}

const FLAG_NAME = 'crash-flag.json';

export function crashFlagPath(dir: string): string {
  return path.join(dir, FLAG_NAME);
}

/** Remember that this run crashed; consumed on next launch. */
export function markCrash(dir: string, entry: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(crashFlagPath(dir), JSON.stringify({ at: new Date().toISOString(), ...entry }));
}

/** Read-and-clear the flag; null when the previous run exited cleanly. */
export function consumeCrashFlag(dir: string): Record<string, unknown> | null {
  const file = crashFlagPath(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { crashKind: 'unknown', crashReason: 'unreadable crash flag' };
  } finally {
    rmSync(file, { force: true });
  }
}
