const http = require('http');
const fs = require('fs');
const path = require('path');
const { enforceStartupDependencyTopology } = require('./scripts/dependency-topology');

enforceStartupDependencyTopology({
  repositoryRoot: __dirname,
  runtimeDirectories: [__dirname, path.join(__dirname, 'backend')],
});

const PORT = 5173;
const DIST = path.resolve(__dirname, 'frontend', 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/')) urlPath = urlPath.slice(1);
  if (!urlPath) urlPath = 'index.html';

  let filePath = path.resolve(DIST, urlPath);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (/^\.(js|css|png|svg|woff|woff2|ico|map)$/.test(ext)) {
        res.writeHead(404); res.end('Not found: ' + urlPath); return;
      }
      fs.readFile(path.join(DIST, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(data2);
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Frontend serving on http://localhost:${PORT} from ${DIST}`);
});
