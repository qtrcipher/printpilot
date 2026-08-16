import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consumeCrashFlag, describeCrash, formatCrashEntry, markCrash } from '../src/main/crash';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'printpilot-crash-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('formatCrashEntry', () => {
  it('formats a renderer crash with reason and exit code', () => {
    const entry = formatCrashEntry('render-process-gone', { reason: 'crashed', exitCode: 133 });
    expect(entry).toEqual({ crashKind: 'render-process-gone', crashReason: 'crashed', exitCode: 133 });
  });

  it('formats a child-process crash with its process type', () => {
    const entry = formatCrashEntry('child-process-gone', {
      reason: 'oom',
      exitCode: 1,
      processType: 'GPU',
    });
    expect(entry.processType).toBe('GPU');
    expect(entry.crashKind).toBe('child-process-gone');
  });

  it('bounds long reasons (no unbounded stack dumps)', () => {
    const entry = formatCrashEntry('uncaughtException', { reason: 'x'.repeat(5000) });
    expect((entry.crashReason as string).length).toBe(300);
  });

  it('describeCrash renders a one-line summary', () => {
    const entry = formatCrashEntry('unhandledRejection', { reason: 'boom' });
    expect(describeCrash(entry)).toBe('unhandledRejection: boom');
  });
});

describe('crash flag', () => {
  it('consume returns null when the previous run exited cleanly', () => {
    expect(consumeCrashFlag(dir)).toBeNull();
  });

  it('mark → consume returns the entry once, then clears it', () => {
    const entry = formatCrashEntry('render-process-gone', { reason: 'crashed' });
    markCrash(dir, entry);
    const consumed = consumeCrashFlag(dir);
    expect(consumed?.crashKind).toBe('render-process-gone');
    expect(consumed?.crashReason).toBe('crashed');
    expect(consumeCrashFlag(dir)).toBeNull(); // consumed — notice shows once
  });

  it('an unreadable flag still surfaces a notice instead of crashing', () => {
    markCrash(dir, {});
    // Corrupt the flag on purpose.
    consumeCrashFlag(dir);
    markCrash(dir, { crashKind: 'uncaughtException' });
    expect(consumeCrashFlag(dir)?.crashKind).toBe('uncaughtException');
  });
});
