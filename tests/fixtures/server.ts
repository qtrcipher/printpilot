import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny static server for the mock Canon Remote UI fixtures (house rule:
 * tests never touch a physical printer). node:http only — no dep.
 * Routes: / → top.html, /<page>.html → fixture file, POST /login → 302 to
 * /top.html (emulates a successful Remote UI login).
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'canon');

export interface FixtureServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startFixtureServer(port: number): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/login') {
      res.writeHead(302, { location: '/top.html' });
      res.end();
      return;
    }
    const name = url.pathname === '/' ? 'top.html' : path.basename(url.pathname);
    void fs
      .readFile(path.join(FIXTURE_DIR, name))
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
