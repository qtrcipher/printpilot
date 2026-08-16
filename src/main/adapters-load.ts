import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateAdapterManifest, type AdapterManifest } from './adapters';

/**
 * Filesystem half of the adapter loader (Electron main only — the renderer
 * and webview preload import the pure schema/resolution code from
 * adapters.ts, which must stay free of node builtins).
 */

/** Load + validate every *.json manifest in `dir`. Invalid files are skipped. */
export async function loadAdapterManifests(dir: string): Promise<AdapterManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // no adapter dir (e.g. unusual package layout) → generic only
  }
  const manifests: AdapterManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, entry), 'utf8'));
      manifests.push(validateAdapterManifest(parsed));
    } catch {
      // A broken manifest must not take down the others — generic fallback stands.
    }
  }
  return manifests;
}
