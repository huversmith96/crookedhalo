import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const gameFile = path.join(root, 'crooked-halo.html');
const port = Number(process.env.PORT) || 4173;

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, game: 'Crooked Halo' }));
    return;
  }
  const requestPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (['/assets/portrait-wayfarer.svg', '/assets/portrait-bellkeeper.svg', '/assets/crooked-country.svg'].includes(requestPath)) {
    try {
      const asset = path.join(root, requestPath.slice(1));
      const body = await readFile(asset);
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Illustration not found.');
    }
    return;
  }
  if (requestPath === '/' || requestPath === '/crooked-halo.html') {
    try {
      const html = await readFile(gameFile);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Crooked Halo could not read its game page.');
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Crooked Halo is running at http://localhost:${port}`);
});
