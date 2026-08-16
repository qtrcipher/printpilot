import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_ADAPTER,
  isLoginUrl,
  resolveAdapter,
  validateAdapterManifest,
  AdapterValidationError,
} from '../src/main/adapters';
import { loadAdapterManifests } from '../src/main/adapters-load';

describe('validateAdapterManifest', () => {
  const valid = {
    id: 'canon-mf750',
    vendor: 'canon',
    models: ['MF750'],
    remoteUiMarkers: ['canon', 'remote ui'],
    login: {
      urlPatterns: ['/login'],
      formSelector: 'form',
      passwordSelector: 'input[type="password"]',
    },
    knownPages: [{ name: 'top', urlPatterns: ['^/$'] }],
    focusSkip: ['.ad'],
  };

  it('accepts a complete manifest', () => {
    const manifest = validateAdapterManifest(valid);
    expect(manifest.id).toBe('canon-mf750');
    expect(manifest.login.urlPatterns).toEqual(['/login']);
    expect(manifest.focusSkip).toEqual(['.ad']);
  });

  it('fills optional sections with defaults', () => {
    const manifest = validateAdapterManifest({ id: 'x', vendor: 'canon' });
    expect(manifest.models).toEqual([]);
    expect(manifest.knownPages).toEqual([]);
    expect(manifest.focusSkip).toEqual([]);
    expect(manifest.login).toEqual(GENERIC_ADAPTER.login);
  });

  it.each([
    ['non-object', 42],
    ['array', []],
    ['missing id', { vendor: 'canon' }],
    ['empty id', { id: '  ', vendor: 'canon' }],
    ['non-string vendor', { id: 'x', vendor: 1 }],
    ['bad login', { id: 'x', vendor: 'c', login: 'nope' }],
    ['login without formSelector', { id: 'x', vendor: 'c', login: { passwordSelector: 'p' } }],
    ['models not strings', { id: 'x', vendor: 'c', models: [1] }],
    ['knownPages not array', { id: 'x', vendor: 'c', knownPages: {} }],
    ['knownPage without name', { id: 'x', vendor: 'c', knownPages: [{ urlPatterns: [] }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => validateAdapterManifest(input)).toThrow(AdapterValidationError);
  });

  it('accepts the shipped canon-mf750 manifest', async () => {
    const raw = await fs.readFile(
      path.join(import.meta.dirname, '..', 'adapters', 'canon-mf750.json'),
      'utf8',
    );
    const manifest = validateAdapterManifest(JSON.parse(raw));
    expect(manifest.id).toBe('canon-mf750');
    expect(manifest.vendor).toBe('canon');
    expect(manifest.models.length).toBeGreaterThan(0);
    expect(manifest.remoteUiMarkers).toContain('/rui/');
  });
});

describe('loadAdapterManifests', () => {
  it('loads valid manifests and skips broken files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'printpilot-adapters-'));
    await fs.writeFile(
      path.join(dir, 'good.json'),
      JSON.stringify({ id: 'a', vendor: 'canon' }),
    );
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
    await fs.writeFile(
      path.join(dir, 'invalid.json'),
      JSON.stringify({ vendor: 'no-id' }),
    );
    await fs.writeFile(path.join(dir, 'ignored.txt'), 'hi');

    const manifests = await loadAdapterManifests(dir);
    expect(manifests.map((m) => m.id)).toEqual(['a']);
  });

  it('returns an empty list when the directory is missing', async () => {
    await expect(loadAdapterManifests('/no/such/dir')).resolves.toEqual([]);
  });
});

describe('resolveAdapter', () => {
  const canon = validateAdapterManifest({
    id: 'canon-mf750',
    vendor: 'canon',
    models: ['MF750', 'MF752Cdw'],
  });

  it('prefers an explicit adapter id', () => {
    const { adapter, matched } = resolveAdapter([canon], { adapterId: 'canon-mf750' });
    expect(adapter.id).toBe('canon-mf750');
    expect(matched).toBe(true);
  });

  it('matches by vendor + model (substring, case-insensitive)', () => {
    const { adapter, matched } = resolveAdapter([canon], {
      vendor: 'Canon',
      model: 'MF750Cdw Series',
    });
    expect(adapter.id).toBe('canon-mf750');
    expect(matched).toBe(true);
  });

  it('matches by vendor alone when it is unambiguous', () => {
    const { adapter, matched } = resolveAdapter([canon], { vendor: 'canon' });
    expect(adapter.id).toBe('canon-mf750');
    expect(matched).toBe(true);
  });

  it('falls back to the vendor adapter when the model is unknown', () => {
    // One Canon layout is a better guess than none (login selectors likely carry over).
    const { adapter, matched } = resolveAdapter([canon], { vendor: 'canon', model: 'PIXMA' });
    expect(adapter.id).toBe('canon-mf750');
    expect(matched).toBe(true);
  });

  it('falls back to generic for unknown vendors/ids', () => {
    for (const query of [
      {},
      { vendor: 'hp', model: 'LaserJet' },
      { adapterId: 'does-not-exist' },
    ]) {
      const { adapter, matched } = resolveAdapter([canon], query);
      expect(adapter.id).toBe('generic');
      expect(matched).toBe(false);
    }
  });
});

describe('isLoginUrl', () => {
  const adapter = validateAdapterManifest({
    id: 'a',
    vendor: 'c',
    login: {
      urlPatterns: ['/login', 'login.html'],
      formSelector: 'form',
      passwordSelector: 'input[type="password"]',
    },
  });

  it('matches configured login URL patterns', () => {
    expect(isLoginUrl('http://192.168.1.50/login', adapter)).toBe(true);
    expect(isLoginUrl('http://192.168.1.50/login.html?x=1', adapter)).toBe(true);
  });

  it('rejects non-login URLs', () => {
    expect(isLoginUrl('http://192.168.1.50/top.html', adapter)).toBe(false);
    expect(isLoginUrl('not a url', adapter)).toBe(false);
  });

  it('never matches for the generic adapter (no patterns)', () => {
    expect(isLoginUrl('http://192.168.1.50/login', GENERIC_ADAPTER)).toBe(false);
  });
});
