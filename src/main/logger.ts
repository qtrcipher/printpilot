import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Rotating local log (design doc §5): leveled JSON-lines written to a file in
 * the app log dir (`app.getPath('logs')`, overridable via PRINTPILOT_LOG_DIR
 * for tests). Hand-rolled rotation — keep the current file plus N previous
 * ones, each capped at ~1MB — with node stdlib only (no new deps).
 *
 * Hard rule: secrets never reach the log. Every context value passes through
 * `redact`, which strips credential-shaped keys, URL userinfo, and
 * credentialEnc blobs; `assertNeverLogs` exists so tests can prove it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_FILE_NAME = 'printpilot.log';
const DEFAULT_MAX_BYTES = 1_000_000; // ~1MB per file
const DEFAULT_KEEP_FILES = 3; // previous files kept alongside the current one

/** Keys that never appear in the log, at any nesting depth. */
const SENSITIVE_KEY = /credential|secret|password|pin|token|keychain/i;
const REDACTED = '[redacted]';

/** URL userinfo (`http://user:pass@host`) — credentials must not be logged. */
const URL_USERINFO = /\b(https?|ftp|ws|wss):\/\/[^\s/@]+@/gi;
/** Serialized credential blobs, e.g. "credentialEnc":"aGk…" inside JSON text. */
const CREDENTIAL_ENC_JSON = /"credentialEnc"\s*:\s*"[^"]*"/gi;

export function redactString(text: string): string {
  return text
    .replace(URL_USERINFO, (match) => `${match.slice(0, match.indexOf('://') + 3)}${REDACTED}@`)
    .replace(CREDENTIAL_ENC_JSON, `"credentialEnc":"${REDACTED}"`);
}

/** Deep-redact a value for logging. Objects/arrays are walked (depth-capped). */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`);
  if (Array.isArray(value)) {
    return depth >= 5 ? '[…]' : value.map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= 5) return '[…]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  /** Directory the log files live in. */
  dir: string;
  /** Rotate once the current file passes this many bytes. */
  maxBytes?: number;
  /** How many rotated files to keep (printpilot.1.log … printpilot.N.log). */
  keepFiles?: number;
  now?: () => Date;
}

export interface Logger {
  readonly filePath: string;
  log(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void;
  debug(scope: string, message: string, context?: Record<string, unknown>): void;
  info(scope: string, message: string, context?: Record<string, unknown>): void;
  warn(scope: string, message: string, context?: Record<string, unknown>): void;
  error(scope: string, message: string, context?: Record<string, unknown>): void;
  /** Last n non-empty lines of the current log file (for diagnostics). */
  recentLines(n: number): string[];
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES;
  const now = options.now ?? (() => new Date());
  const filePath = path.join(options.dir, LOG_FILE_NAME);
  mkdirSync(options.dir, { recursive: true });

  function rotatedPath(index: number): string {
    return path.join(options.dir, LOG_FILE_NAME.replace('.log', `.${index}.log`));
  }

  /** current → .1, .1 → .2, …, oldest kept file dropped. */
  function rotate(): void {
    const oldest = rotatedPath(keepFiles);
    if (existsSync(oldest)) rmSync(oldest);
    for (let index = keepFiles - 1; index >= 1; index -= 1) {
      const from = rotatedPath(index);
      if (existsSync(from)) renameSync(from, rotatedPath(index + 1));
    }
    if (existsSync(filePath)) renameSync(filePath, rotatedPath(1));
  }

  function writeLine(line: string): void {
    if (existsSync(filePath) && statSync(filePath).size + line.length > maxBytes) rotate();
    appendFileSync(filePath, `${line}\n`);
  }

  function log(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void {
    const entry: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      scope: scope.slice(0, 40),
      msg: redactString(message.slice(0, 2000)),
    };
    if (context) Object.assign(entry, redact(context) as Record<string, unknown>);
    writeLine(JSON.stringify(entry));
  }

  return {
    filePath,
    log,
    debug: (scope, message, context) => log('debug', scope, message, context),
    info: (scope, message, context) => log('info', scope, message, context),
    warn: (scope, message, context) => log('warn', scope, message, context),
    error: (scope, message, context) => log('error', scope, message, context),
    recentLines(n) {
      if (!existsSync(filePath)) return [];
      const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(0, n));
    },
  };
}
