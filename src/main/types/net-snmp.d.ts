/**
 * Minimal declarations for net-snmp (pure-JS SNMP, ships no .d.ts).
 * Covers only what discovery-net.ts uses.
 */
declare module 'net-snmp' {
  import type { EventEmitter } from 'node:events';

  export interface SessionOptions {
    version?: number;
    port?: number;
    timeout?: number;
    retries?: number;
  }

  export interface Varbind {
    oid: string;
    type: number;
    value: string | number | Buffer;
  }

  export class Session extends EventEmitter {
    get(oids: string[], cb: (error: Error | null, varbinds?: Varbind[]) => void): void;
    close(): void;
  }

  export const Version1: number;
  export const Version2c: number;
  export function createSession(
    target: string,
    community?: string,
    options?: SessionOptions,
  ): Session;

  const snmp: {
    Session: typeof Session;
    Version1: number;
    Version2c: number;
    createSession: typeof createSession;
  };
  export default snmp;
}
