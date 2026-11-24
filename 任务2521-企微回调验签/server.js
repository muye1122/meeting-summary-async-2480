/**
 * Production-style launcher: starts the callback API on PORT and serves the
 * built demo UI on H5_PORT with /api proxied to the API process.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PORT = process.env.PORT || '3001';
await import('./mock-server/index.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function proxyRequest(req, res) {
  const opts = {
    hostname: '127.0.0.1', port: process.env.PORT, path: req.url, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${process.env.PORT}` },
  };
  const p = http.request(opts, (upstream) => {
    res.writeHead(upstream.statusCode || 200, upstream.headers);
    upstream.pipe(res);
  });
  p.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(p);
}

const ui = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxyRequest(req, res);
  let file = path.join(dirname, 'dist', decodeURIComponent(url.pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dirname, 'dist', 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not built'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const H5_PORT = Number(process.env.H5_PORT || 4173);
ui.listen(H5_PORT, '0.0.0.0', () => {
  console.log(`[wecom-callback-demo] ui http://0.0.0.0:${H5_PORT}  api http://0.0.0.0:${process.env.PORT}`);
});
