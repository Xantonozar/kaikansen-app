// Temporary UI click-test host for Kaikansen (owner-approved 2026-11-09,
// removed after the test). Serves the Expo web export built into ./dist
// and proxies the app's API paths to the live kaikansen-api under the
// SAME origin, so the browser build can talk to the real API (the API
// itself allows no web origins). The export is built with the literal
// placeholder __API_BASE__ as its API URL; responses rewrite it to this
// service's own public origin per request.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const API_HOST = 'kaikansen-api.onrender.com';
const API_PREFIXES = ['/auth/', '/home', '/search', '/themes/', '/anime/', '/artists/',
  '/library/', '/playlists', '/quiz/', '/users/', '/social/', '/notifications',
  '/rank/', '/stats/', '/season', '/health', '/sync/'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const cache = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const isApi = API_PREFIXES.some(x => p === x || p.startsWith(x));
  if (isApi) {
    const opts = { hostname: API_HOST, path: p + url.search, method: req.method,
      headers: { ...req.headers, host: API_HOST } };
    const up = https.request(opts, u => {
      res.writeHead(u.statusCode, u.headers);
      u.pipe(res);
    });
    up.on('error', e => { res.writeHead(502); res.end('proxy error: ' + e.message); });
    req.pipe(up);
    return;
  }
  let file = path.join(DIST, p === '/' ? 'index.html' : p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html'); // SPA fallback
  }
  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  if (ext === '.js' || ext === '.html') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const origin = proto + '://' + req.headers.host;
    const key = file + '|' + origin;
    if (!cache.has(key)) {
      cache.set(key, fs.readFileSync(file, 'utf8').split('__API_BASE__').join(origin));
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(cache.get(key));
    return;
  }
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});
const port = process.env.PORT || 8099;
server.listen(port, () => console.log('kaikansen-uitest on ' + port));
