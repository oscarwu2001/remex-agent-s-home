'use strict';

// Serves the renderer to an ordinary browser for design work and screenshots,
// with a stand-in bridge that only offers the demo. Not used by the app.
//   npm run preview  ->  http://localhost:5178/?demo=1

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOMS } = require('../src/core/rooms');

const root = path.join(__dirname, '..', 'renderer');
const port = Number(process.env.PORT) || 5178;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const bridge = `export default {
  config: async () => (${JSON.stringify({ rooms: ROOMS, platform: 'browser', version: 'preview' })}),
  onSnapshot: undefined,
};`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/preview-bridge.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(bridge);
      return;
    }
    const file = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Preview on http://localhost:${port}/?demo=1`));
