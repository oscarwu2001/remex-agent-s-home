'use strict';

// Serves the renderer to an ordinary browser for design work and screenshots,
// with a stand-in bridge that only offers the demo. Not used by the app.
//   npm run preview  ->  http://localhost:5178/?demo=1

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEPARTMENT_KINDS, validateLayout, roomsWith, openCells } = require('../src/core/rooms');

const root = path.join(__dirname, '..', 'renderer');
const port = Number(process.env.PORT) || 5178;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// The layout lives in memory here; the app keeps it in layout.json.
let layout = { departments: [] };
const config = () => ({
  rooms: roomsWith(layout), layout, departmentKinds: DEPARTMENT_KINDS, openCells: openCells(layout),
  platform: 'browser', version: 'preview',
});

const bridge = `export default {
  config: async () => (await fetch('/preview/config')).json(),
  saveLayout: async (layout) => (await fetch('/preview/layout', { method: 'POST', body: JSON.stringify(layout) })).json(),
  onSnapshot: undefined,
};`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/preview/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(config()));
      return;
    }
    if (url.pathname === '/preview/layout' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let out;
        try {
          layout = validateLayout(JSON.parse(body));
          out = { ok: true, config: config() };
        } catch (err) {
          out = { ok: false, error: err.message };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
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
