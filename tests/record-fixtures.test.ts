import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-node script without type declarations
import { classifyTargetUrl, extractPageLinks, fileNameForUrl } from '../scripts/record-fixtures.mjs';

/**
 * URL-classification / file-naming logic of the fixture recorder — no
 * network (house rule). The crawl itself only runs against a real printer.
 */

const TOP = 'http://192.168.1.50/';

describe('classifyTargetUrl', () => {
  it('records same-host http page links', () => {
    expect(classifyTargetUrl('/menu.html', TOP)).toBe('record');
    expect(classifyTargetUrl('status.cgi', TOP)).toBe('record');
    expect(classifyTargetUrl('http://192.168.1.50/login', TOP)).toBe('record');
  });

  it('flags other hosts as external — never crawled', () => {
    expect(classifyTargetUrl('https://example.com/x.html', TOP)).toBe('external');
    expect(classifyTargetUrl('http://192.168.1.50:8080/x', TOP)).toBe('external'); // other port
  });

  it('skips non-page targets', () => {
    expect(classifyTargetUrl('#section', TOP)).toBe('skip');
    expect(classifyTargetUrl('mailto:a@b.c', TOP)).toBe('skip');
    expect(classifyTargetUrl('javascript:void(0)', TOP)).toBe('skip');
    expect(classifyTargetUrl('/style.css', TOP)).toBe('skip');
    expect(classifyTargetUrl('/img/logo.png', TOP)).toBe('skip');
    expect(classifyTargetUrl('http://[bad', TOP)).toBe('skip'); // unparseable
  });
});

describe('fileNameForUrl', () => {
  it('maps / to top.html (fixture server convention)', () => {
    expect(fileNameForUrl('/')).toBe('top.html');
    expect(fileNameForUrl('')).toBe('top.html');
  });

  it('keeps explicit extensions and adds .html to bare paths', () => {
    expect(fileNameForUrl('/menu.html')).toBe('menu.html');
    expect(fileNameForUrl('/login')).toBe('login.html');
    expect(fileNameForUrl('/portal/status.cgi')).toBe('status.cgi');
  });

  it('sanitizes filesystem-hostile characters', () => {
    expect(fileNameForUrl('/a b?c')).toBe('a_b_c.html');
  });
});

describe('extractPageLinks', () => {
  it('collects same-host page links once, in order, without hashes', () => {
    const html = `
      <a href="/menu.html">Menu</a>
      <a href='status.html#top'>Status</a>
      <a href="/menu.html">Menu again</a>
      <a href="https://example.com/">External</a>
      <a href="/app.js">Asset</a>
      <a href="#local">Anchor</a>`;
    const links = extractPageLinks(html, TOP).map((u: URL) => u.href);
    expect(links).toEqual(['http://192.168.1.50/menu.html', 'http://192.168.1.50/status.html']);
  });
});
