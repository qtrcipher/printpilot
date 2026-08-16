#!/usr/bin/env node
/**
 * Fixture recorder (house rule: tests never need a physical printer).
 *
 *   node scripts/record-fixtures.mjs <host> [--port N] [--out DIR]
 *
 * Fetches a Canon imageCLASS Remote UI's key pages — /, the login page, and
 * every same-host page linked from the top page (depth-1 crawl) — and saves
 * them as HTML fixtures with an index.json (url → file, fetched-at). Plain
 * node, no dependencies; global fetch (Node 22+).
 *
 * The URL-classification and file-naming logic is exported so the unit test
 * can exercise it without any network.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUT = 'tests/fixtures/canon';

/**
 * Classify a link found on a recorded page.
 *  - 'record'  : same-host http(s) page worth saving
 *  - 'external': different host — never crawled (printer pages stay on-device)
 *  - 'skip'    : not a fetchable page (anchors, mailto:, javascript:, assets)
 */
export function classifyTargetUrl(href, pageUrl) {
  if (!href || href.startsWith('#')) return 'skip';
  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return 'skip';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'skip';
  if (url.host !== new URL(pageUrl).host) return 'external';
  // Only HTML-ish targets: no file extension or a .htm(l)/.cgi extension.
  const ext = path.posix.extname(url.pathname).toLowerCase();
  if (ext && !['.html', '.htm', '.cgi', ''].includes(ext)) return 'skip';
  return 'record';
}

/** Deterministic fixture file name for a URL path. '/' becomes top.html. */
export function fileNameForUrl(pathname) {
  const clean = pathname.replace(/\/+$/, '');
  if (!clean) return 'top.html';
  const base = clean.split('/').pop() ?? 'page';
  const name = base.includes('.') ? base : `${base}.html`;
  // Keep names filesystem-safe and stable across runs.
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Same-host page links in an HTML body, in first-seen order. */
export function extractPageLinks(html, pageUrl) {
  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1];
    if (classifyTargetUrl(href, pageUrl) !== 'record') continue;
    const url = new URL(href, pageUrl);
    url.hash = '';
    const key = url.href;
    if (!seen.has(key)) {
      seen.add(key);
      links.push(url);
    }
  }
  return links;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function main() {
  const args = process.argv.slice(2);
  const host = args[0];
  if (!host || host.startsWith('-')) {
    console.error('Usage: node scripts/record-fixtures.mjs <host> [--port N] [--out DIR]');
    process.exit(1);
  }
  const port = Number(args[args.indexOf('--port') + 1]) || 80;
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : DEFAULT_OUT;

  const origin = `http://${host}:${port}`;
  const bodies = new Map(); // url (no hash) → HTML body

  console.log(`Recording Remote UI fixtures from ${origin} → ${outDir}`);

  const rootUrl = `${origin}/`;
  bodies.set(rootUrl, await fetchText(rootUrl));

  // Depth-1 crawl: every same-host page linked from the top page, plus the
  // conventional login page even if the top page doesn't link to it.
  const targets = extractPageLinks(bodies.get(rootUrl), rootUrl);
  for (const candidate of [`${origin}/login`, `${origin}/login.html`]) {
    if (!targets.some((t) => t.href === candidate)) targets.push(new URL(candidate));
  }

  for (const url of targets) {
    try {
      bodies.set(url.href, await fetchText(url.href));
    } catch (err) {
      console.warn(`  skipping ${url.href} (${err.message})`);
    }
  }

  await mkdir(outDir, { recursive: true });
  const index = { host, port, fetchedAt: new Date().toISOString(), pages: [] };
  const usedFiles = new Set();
  for (const [url, html] of bodies) {
    const file = fileNameForUrl(new URL(url).pathname);
    if (usedFiles.has(file)) {
      console.warn(`  skipping ${url} (file name ${file} already used)`);
      continue;
    }
    usedFiles.add(file);
    await writeFile(path.join(outDir, file), html);
    index.pages.push({ url, file });
    console.log(`  saved ${url} → ${file}`);
  }
  await writeFile(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  console.log(`
Done — ${index.pages.length} page(s) recorded. Verify before committing:
  [ ] No credentials or session cookies appear in any recorded file
      (log out of the Remote UI before recording; grep for your PIN).
  [ ] Device-specific data you're comfortable publishing (serial numbers,
      device names) — anonymize in the fixtures if not.
  [ ] Login page markup includes the real password form selectors; compare
      with adapters/canon-mf750.json and update the adapter if they differ.
  [ ] Re-run: npm test && npm run test:e2e — fixtures are shared by both.
`);
}

// Run only as a script, not when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`record-fixtures failed: ${err.message}`);
    process.exit(1);
  });
}
