// Read-only static file server, plus live reload in dev mode. Nothing it serves can change files.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { escapeHtml as h } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8', '.xml': 'application/xml', '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8',
  '.avsc': 'application/json; charset=utf-8', '.proto': 'text/plain; charset=utf-8', '.graphql': 'text/plain; charset=utf-8',
};

const safeEqual = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function startServer({ out, port = 3000, host = '127.0.0.1', base = '/', dev = false, auth, onListening }) {
  // Pages poll this. Holding a connection open per tab would use up the browser's six per site.
  let buildVersion = String(Date.now());
  const realOut = () => fs.realpathSync(out);

  const server = http.createServer((req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    if (auth) {
      const expected = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
      if (!safeEqual(req.headers.authorization || '', expected)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="catalog"' });
        res.end('Authentication required');
        return;
      }
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      send(400, 'text/plain', 'Bad request');
      return;
    }
    if (dev && pathname === '/__reload') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(buildVersion);
      return;
    }
    const prefix = base.replace(/\/$/, '');
    if (prefix && !pathname.startsWith(`${prefix}/`) && pathname !== prefix) {
      send(404, 'text/plain', 'Not found');
      return;
    }
    const local = pathname.slice(prefix.length) || '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'text/plain', 'Method not allowed');
      return;
    }
    const rootDir = realOut();
    let target = path.resolve(rootDir, `.${path.posix.normalize(local)}`);
    if (target !== rootDir && !target.startsWith(`${rootDir}${path.sep}`)) {
      send(403, 'text/plain', 'Forbidden');
      return;
    }
    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      const real = fs.realpathSync(target);
      if (!real.startsWith(`${rootDir}${path.sep}`)) throw new Error('outside site');
      const type = local.endsWith('/.well-known/api-catalog') ? 'application/linkset+json' : MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(real).pipe(res);
    } catch {
      send(404, MIME['.html'], `<!doctype html><title>Not found</title><link rel="stylesheet" href="${h(base)}_dc/app.css"/><div class="dc-shell"><h1>Page not found</h1><p><a href="${h(base)}">Back to the catalog</a></p></div>`);
    }
  });
  server.listen(port, host, () => onListening?.(server.address().port));
  return {
    server,
    reload: () => {
      buildVersion = String(Date.now());
    },
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
