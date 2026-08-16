import type { PrinterProfile } from './profiles';
import { GAMEPAD_ACTIONS, type SettingsFile } from './settings';

/**
 * "Copy diagnostics" payload (design doc §5/§7): app/OS versions, adapter
 * list, and a settings + profile summary. There is no log system yet, so
 * this assembles what exists. Hard rule: secrets never leave the machine —
 * profile credential blobs are replaced by a boolean and PINs never appear.
 */

export interface DiagnosticsInput {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  platform: NodeJS.Platform;
  osRelease: string;
  arch: string;
  adapterIds: string[];
  settings: SettingsFile;
  /** Raw store profiles — this function is responsible for redaction. */
  profiles: PrinterProfile[];
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { settings } = input;
  const remapped = GAMEPAD_ACTIONS.filter((a) => settings.gamepad[a] !== undefined);
  const lines: string[] = [
    'PrintPilot diagnostics',
    `App: ${input.appVersion} (Electron ${input.electronVersion}, Chromium ${input.chromeVersion})`,
    `OS: ${input.platform} ${input.arch} ${input.osRelease}`,
    `Adapters: ${input.adapterIds.length > 0 ? input.adapterIds.join(', ') : '(none loaded)'}`,
    '',
    'Settings:',
    `  theme: ${settings.theme}`,
    `  keyboardScheme: ${settings.keyboardScheme}`,
    `  discovery: mdns=${settings.discovery.mdnsEnabled} snmp=${settings.discovery.snmpEnabled} scanWindowMs=${settings.discovery.scanWindowMs}`,
    `  gamepad: ${remapped.length > 0 ? `remapped [${remapped.join(', ')}]` : 'defaults'}`,
    `  onboardingSeen: ${settings.onboardingSeen}`,
    '',
    `Profiles (${input.profiles.length}):`,
  ];
  for (const p of input.profiles) {
    const name = [p.vendor, p.model].filter(Boolean).join(' ');
    lines.push(
      `  - ${p.nickname} (${p.host}) adapter=${p.adapter || 'auto'}${name ? ` ${name}` : ''}` +
        ` credential=${p.credentialEnc ? 'saved' : 'none'}` +
        (p.lastConnected ? ` lastConnected=${p.lastConnected}` : ''),
    );
  }
  return `${lines.join('\n')}\n`;
}
