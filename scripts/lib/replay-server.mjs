import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.pdf': 'application/pdf',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createReplayServer(root) {
  root = fs.realpathSync(root);
  const inside = file => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  return http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    let file;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return res.writeHead(400).end();
      file = path.resolve(root, `.${pathname}`);
    } catch { return res.writeHead(400).end(); }
    if (!inside(file)) return res.writeHead(403).end();
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      file = fs.realpathSync(file);
      if (!inside(file)) return res.writeHead(403).end();
      const stat = fs.statSync(file);
      if (!stat.isFile()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
}
