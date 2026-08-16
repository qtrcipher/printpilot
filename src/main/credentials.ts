import { safeStorage } from 'electron';
import type { CredentialCipher } from './profiles';

/**
 * Design doc §4 credential mechanism: Electron safeStorage IS the
 * OS-keychain-backed store (DPAPI on Windows, libsecret/kwallet on Linux,
 * Keychain on macOS). Profiles persist only the base64 blob it returns
 * (`credentialEnc`), never plaintext.
 *
 * Electron-bound — unit tests inject a fake cipher into ProfileStore instead.
 */
export class CredentialUnavailableError extends Error {}

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new CredentialUnavailableError(
      'OS keychain encryption is not available on this system (no DPAPI/libsecret backend)',
    );
  }
}

export function createSafeStorageCipher(): CredentialCipher {
  return {
    encrypt(plain) {
      assertAvailable();
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(blob) {
      assertAvailable();
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    },
  };
}
