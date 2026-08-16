import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, redact, redactString } from '../src/main/logger';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'printpilot-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('redactString', () => {
  it('strips URL userinfo (credentials in URLs)', () => {
    expect(redactString('GET http://admin:hunter2@192.168.1.50/login failed')).toBe(
      'GET http://[redacted]@192.168.1.50/login failed',
    );
    expect(redactString('https://user:p%40ss@printer.local/')).toBe('https://[redacted]@printer.local/');
  });

  it('strips serialized credentialEnc blobs', () => {
    expect(redactString('profile {"id":"p1","credentialEnc":"aHVudGVyMg=="} saved')).toBe(
      'profile {"id":"p1","credentialEnc":"[redacted]"} saved',
    );
  });

  it('leaves ordinary messages alone', () => {
    expect(redactString('printer found at 192.168.1.50:80')).toBe('printer found at 192.168.1.50:80');
  });
});

describe('redact (malicious-looking inputs)', () => {
  it('redacts credential-shaped keys at any depth', () => {
    const out = redact({
      host: '192.168.1.50',
      credentialEnc: 'SECRET-BLOB',
      nested: { password: 'hunter2', pin: '1234', sessionToken: 'tok', ok: true },
      list: [{ secret: 'x', name: 'y' }],
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain('SECRET-BLOB');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('tok');
    expect(out.host).toBe('192.168.1.50');
    expect((out.nested as Record<string, unknown>).ok).toBe(true);
  });

  it('redacts URLs with credentials inside nested strings', () => {
    const out = redact({ url: 'http://root:toor@192.168.1.50/' }) as { url: string };
    expect(out.url).toBe('http://[redacted]@192.168.1.50/');
  });

  it('formats errors without leaking credential text', () => {
    const out = redact({ err: new Error('login failed for http://admin:hunter2@printer/') }) as {
      err: string;
    };
    expect(out.err).toContain('login failed');
    expect(out.err).not.toContain('hunter2');
  });

  it('depth-caps cyclic/deep structures instead of recursing forever', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i += 1) {
      node.next = {};
      node = node.next as Record<string, unknown>;
    }
    expect(() => redact(deep)).not.toThrow();
  });
});

describe('createLogger', () => {
  it('writes leveled JSON-lines to printpilot.log', () => {
    const logger = createLogger({ dir, now: () => new Date('2026-08-17T00:00:00Z') });
    logger.info('discovery', 'printer found', { host: '192.168.1.50' });
    const line = JSON.parse(readFileSync(logger.filePath, 'utf8').trim()) as Record<string, unknown>;
    expect(line.ts).toBe('2026-08-17T00:00:00.000Z');
    expect(line.level).toBe('info');
    expect(line.scope).toBe('discovery');
    expect(line.msg).toBe('printer found');
    expect(line.host).toBe('192.168.1.50');
  });

  it('redacts secret-shaped context before it hits the file', () => {
    const logger = createLogger({ dir });
    logger.info('profiles', 'credential saved', { credentialEnc: 'SECRET-BLOB', pin: '9999' });
    const raw = readFileSync(logger.filePath, 'utf8');
    expect(raw).not.toContain('SECRET-BLOB');
    expect(raw).not.toContain('9999');
  });

  it('rotates at the size cap, keeping current + 3 previous files', () => {
    const logger = createLogger({ dir, maxBytes: 200, keepFiles: 3 });
    for (let i = 0; i < 40; i += 1) {
      logger.info('test', `entry number ${i} — padding padding padding padding`);
    }
    const files = readdirSync(dir).sort();
    expect(files.length).toBeLessThanOrEqual(4); // current + 3 previous
    expect(files).toContain('printpilot.log');
    // The newest entry survives in the current file.
    expect(readFileSync(path.join(dir, 'printpilot.log'), 'utf8')).toContain('entry number 39');
    // Nothing older than 4 generations survives.
    expect(files).not.toContain('printpilot.4.log');
  });

  it('recentLines returns the last n non-empty lines', () => {
    const logger = createLogger({ dir });
    for (let i = 0; i < 60; i += 1) logger.info('test', `line ${i}`);
    const recent = logger.recentLines(50);
    expect(recent).toHaveLength(50);
    expect(recent[0]).toContain('line 10');
    expect(recent[49]).toContain('line 59');
  });

  it('recentLines on a missing log returns []', () => {
    const logger = createLogger({ dir });
    expect(logger.recentLines(50)).toEqual([]);
  });

  it('pre-existing content is appended, not truncated', () => {
    writeFileSync(path.join(dir, 'printpilot.log'), '{"old":1}\n');
    const logger = createLogger({ dir });
    logger.info('test', 'new');
    expect(readFileSync(logger.filePath, 'utf8')).toContain('{"old":1}');
  });
});
