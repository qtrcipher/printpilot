import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CredentialError,
  ProfileStore,
  profilesPath,
  type CredentialCipher,
  type NewProfile,
} from '../src/main/profiles';

/** Deterministic fake cipher — tests never touch the OS keychain. */
const fakeCipher: CredentialCipher = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (blob) => blob.replace(/^enc:/, ''),
};

const sample: NewProfile = {
  nickname: 'Office MF750',
  host: '192.168.1.50',
  vendor: 'canon',
  model: 'MF753Cdw',
  adapter: 'canon-mf750',
};

describe('ProfileStore', () => {
  let dir: string;
  let store: ProfileStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'printpilot-profiles-'));
    store = new ProfileStore(dir, fakeCipher);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with an empty list', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('adds profiles with generated unique ids', async () => {
    const a = await store.add(sample);
    const b = await store.add({ ...sample, nickname: 'Lab printer', host: '192.168.1.51' });
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('renames a profile and reports unknown ids', async () => {
    const added = await store.add(sample);
    const renamed = await store.rename(added.id, 'Front desk');
    expect(renamed?.nickname).toBe('Front desk');
    expect((await store.list())[0]?.nickname).toBe('Front desk');
    expect(await store.rename('no-such-id', 'x')).toBeNull();
  });

  it('removes profiles and reports unknown ids', async () => {
    const added = await store.add(sample);
    expect(await store.remove(added.id)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.remove(added.id)).toBe(false);
  });

  it('updates lastConnected as an ISO timestamp', async () => {
    const added = await store.add(sample);
    const touched = await store.touchLastConnected(added.id, new Date('2026-08-16T12:00:00Z'));
    expect(touched?.lastConnected).toBe('2026-08-16T12:00:00.000Z');
  });

  it('stores credentials encrypted, never plaintext', async () => {
    const added = await store.add(sample);
    await store.setCredential(added.id, 'hunter2');

    const onDisk = await readFile(profilesPath(dir), 'utf8');
    expect(onDisk).toContain('enc:hunter2');
    const parsed = JSON.parse(onDisk) as { printers: Array<{ credentialEnc?: string }> };
    expect(parsed.printers[0]?.credentialEnc).toBe('enc:hunter2');
    // Round-trips back to the plaintext secret.
    expect(await store.getCredential(added.id)).toBe('hunter2');
  });

  it('returns null for a profile without a credential', async () => {
    const added = await store.add(sample);
    expect(await store.getCredential(added.id)).toBeNull();
  });

  it('fails credential ops with a clear error when no cipher is available', async () => {
    const bare = new ProfileStore(dir); // no cipher — like safeStorage unavailable
    const added = await bare.add(sample);
    await expect(bare.setCredential(added.id, 'x')).rejects.toThrow(CredentialError);
    await expect(bare.setCredential('no-such-id', 'x')).rejects.toThrow(CredentialError);
  });

  it('writes atomically: no tmp file is left behind', async () => {
    await store.add(sample);
    expect(existsSync(`${profilesPath(dir)}.tmp`)).toBe(false);
    expect(existsSync(profilesPath(dir))).toBe(true);
  });

  it('refuses profiles files written by a newer app version', async () => {
    await writeFile(profilesPath(dir), JSON.stringify({ version: 99, printers: [] }));
    await expect(store.list()).rejects.toThrow(/newer than supported/);
  });
});
