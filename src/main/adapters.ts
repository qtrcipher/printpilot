/**
 * Adapter manifests (design doc §3): per-model JSON describing a printer's
 * Remote UI — login selectors, known page URL patterns, focus-order skips,
 * and the HTML markers discovery already uses for classification. Adapters
 * are data, not code, so contributors add models without touching core; the
 * loader validates each manifest against the schema below (hand-rolled, no
 * ajv dep) and falls back to a built-in generic adapter when nothing matches
 * (design doc §5: adapter mismatch degrades, app stays usable).
 *
 * Kept free of Electron and node-builtin imports so the renderer, webview
 * preload, and Vitest all exercise the same code; the fs-backed directory
 * loader lives in adapters-load.ts (Electron main only).
 */

export interface AdapterLogin {
  /** URL substrings identifying the Remote UI login page. */
  urlPatterns: string[];
  /** CSS selector for the login form (used to watch for PIN submission). */
  formSelector: string;
  /** CSS selector for the PIN/password field inside the form. */
  passwordSelector: string;
}

export interface AdapterKnownPage {
  name: string;
  urlPatterns: string[];
}

export interface AdapterManifest {
  id: string;
  vendor: string;
  /** Model name fragments matched case-insensitively (substring, both ways). */
  models: string[];
  /** Remote UI HTML markers — same heuristics as discovery's classifier. */
  remoteUiMarkers: string[];
  login: AdapterLogin;
  knownPages: AdapterKnownPage[];
  /** CSS selectors for elements the focus ring should skip. */
  focusSkip: string[];
}

/**
 * Generic adapter: no model knowledge, generic focus ring over all
 * interactive elements, generic password-form login detection.
 */
export const GENERIC_ADAPTER: AdapterManifest = {
  id: 'generic',
  vendor: '',
  models: [],
  remoteUiMarkers: [],
  login: {
    urlPatterns: [],
    formSelector: 'form',
    passwordSelector: 'input[type="password"]',
  },
  knownPages: [],
  focusSkip: [],
};

export class AdapterValidationError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asStringArray(value: unknown, field: string, allowEmpty = true): string[] {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AdapterValidationError(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Validate parsed JSON against the manifest schema. Throws
 * AdapterValidationError naming the offending field. Unknown fields are
 * tolerated (forward compatibility); missing required fields are not.
 */
export function validateAdapterManifest(data: unknown): AdapterManifest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AdapterValidationError('manifest must be a JSON object');
  }
  const raw = data as Record<string, unknown>;
  if (!isNonEmptyString(raw.id)) throw new AdapterValidationError('id must be a non-empty string');
  if (typeof raw.vendor !== 'string') throw new AdapterValidationError('vendor must be a string');

  let login: AdapterLogin;
  if (raw.login === undefined) {
    login = { ...GENERIC_ADAPTER.login };
  } else {
    if (typeof raw.login !== 'object' || raw.login === null) {
      throw new AdapterValidationError('login must be an object');
    }
    const rawLogin = raw.login as Record<string, unknown>;
    if (!isNonEmptyString(rawLogin.formSelector)) {
      throw new AdapterValidationError('login.formSelector must be a non-empty string');
    }
    if (!isNonEmptyString(rawLogin.passwordSelector)) {
      throw new AdapterValidationError('login.passwordSelector must be a non-empty string');
    }
    login = {
      urlPatterns: asStringArray(rawLogin.urlPatterns, 'login.urlPatterns'),
      formSelector: rawLogin.formSelector,
      passwordSelector: rawLogin.passwordSelector,
    };
  }

  const knownPages: AdapterKnownPage[] = [];
  if (raw.knownPages !== undefined) {
    if (!Array.isArray(raw.knownPages)) {
      throw new AdapterValidationError('knownPages must be an array');
    }
    for (const [index, page] of raw.knownPages.entries()) {
      if (typeof page !== 'object' || page === null) {
        throw new AdapterValidationError(`knownPages[${index}] must be an object`);
      }
      const rawPage = page as Record<string, unknown>;
      if (!isNonEmptyString(rawPage.name)) {
        throw new AdapterValidationError(`knownPages[${index}].name must be a non-empty string`);
      }
      knownPages.push({
        name: rawPage.name,
        urlPatterns: asStringArray(rawPage.urlPatterns, `knownPages[${index}].urlPatterns`),
      });
    }
  }

  return {
    id: raw.id,
    vendor: raw.vendor,
    models: asStringArray(raw.models, 'models'),
    remoteUiMarkers: asStringArray(raw.remoteUiMarkers, 'remoteUiMarkers'),
    login,
    knownPages,
    focusSkip: asStringArray(raw.focusSkip, 'focusSkip'),
  };
}

export interface AdapterQuery {
  vendor?: string;
  model?: string;
  adapterId?: string;
}

export interface AdapterResolution {
  adapter: AdapterManifest;
  /** false when nothing matched and the generic fallback is in use. */
  matched: boolean;
}

function modelMatches(manifestModels: string[], model: string): boolean {
  const needle = model.toLowerCase();
  return manifestModels.some((m) => {
    const candidate = m.toLowerCase();
    return needle.includes(candidate) || candidate.includes(needle);
  });
}

/**
 * Pick an adapter by adapter id, then vendor+model, then vendor alone;
 * otherwise the generic fallback (matched: false).
 */
export function resolveAdapter(
  manifests: readonly AdapterManifest[],
  query: AdapterQuery,
): AdapterResolution {
  if (query.adapterId) {
    const byId = manifests.find((m) => m.id === query.adapterId && m.id !== GENERIC_ADAPTER.id);
    if (byId) return { adapter: byId, matched: true };
  }
  const vendor = query.vendor?.toLowerCase() ?? '';
  if (vendor) {
    const forVendor = manifests.filter((m) => m.vendor.toLowerCase() === vendor);
    if (query.model) {
      const byModel = forVendor.find((m) => modelMatches(m.models, query.model ?? ''));
      if (byModel) return { adapter: byModel, matched: true };
    }
    if (forVendor.length === 1 && forVendor[0]) {
      return { adapter: forVendor[0], matched: true };
    }
  }
  return { adapter: GENERIC_ADAPTER, matched: false };
}

/** True when `url` looks like the adapter's login page. */
export function isLoginUrl(url: string, adapter: AdapterManifest): boolean {
  if (adapter.login.urlPatterns.length === 0) return false;
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  return adapter.login.urlPatterns.some((pattern) => path.includes(pattern.toLowerCase()));
}
