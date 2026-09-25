'use strict';

// Serves the renderer to an ordinary browser for design work and screenshots,
// with a stand-in bridge that only offers the demo. Not used by the app.
//   npm run preview  ->  http://localhost:5178/?demo=1

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEPARTMENT_KINDS, validateLayout, roomsWith, gardensWith, openCells } = require('../src/core/rooms');
const D = require('../src/core/decor');
const { EventEmitter } = require('events');
const { runTask, continueTask, toSession } = require('../src/assistant/pipeline');
const team = require('../src/assistant/team');
const { findIdentifiers } = require('../src/assistant/phi');
const { roomFor } = require('../src/core/rooms');

// A stand-in for the Assistant: the real pipeline with a scripted client,
// slowed down so the team can be seen at work. No network, no key.
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const SAMPLE = {
  writer: 'Hi everyone,\n\nA quick reminder to send your **timesheets by Friday 5 pm**. If you are away that day, please send them on Thursday.\n\nThank you!\n\nBest regards,',
  summariser: 'The report proposes moving the lab to the new building by June.\n\n- Cost: about $40,000, mostly movers and new benches\n- Downtime: two weeks, planned for the spring break\n- Risk: the MRI booking system must move first\n\n**Action items:** confirm the movers by 15 March; tell the booking office.',
  planner: '1. List what needs to move (this week)\n2. Book the movers (by 15 March)\n3. Tell every team the downtime dates\n4. Move the booking system first\n5. Move the lab and test everything\n\n**Recommendation:** start with step 4, because everything else depends on it.',
  'data-helper': '| Item | Cost |\n| --- | --- |\n| Movers | $18,000 |\n| Benches | $15,500 |\n| IT | $6,000 |\n| **Total** | **$39,500** |\n\n18,000 + 15,500 + 6,000 = 39,500.',
  coach: '**Q1. Who needs to be there?**\nThe whole team, or only leads?\n→ Suggested answer: the whole team, because Monday sets the week.\n\n**Q2. What happens to the Friday slot?**\n→ Suggested answer: keep it free for focus work.',
  teacher: 'Before we start: **what will you use this for?** For example, monthly reports or one-off analyses. Tell me and I will shape the first lesson around it.',
  helper: 'A PDF keeps its layout on every computer, so it is best for sharing final documents. A Word file is better while people are still editing.',
};
function fakeClient() {
  const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const pick = (text) => (/summar|report|key points/i.test(text) ? 'summariser' : /plan|schedule|steps/i.test(text) ? 'planner'
    : /total|table|cost|sum|numbers/i.test(text) ? 'data-helper' : /email|write|draft|letter|reply/i.test(text) ? 'writer' : 'helper');
  return {
    messages: {
      async create(params, opts) {
        await pause(params.tools ? 900 : 1800);
        if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (params.tools) {
          const text = params.messages[0].content;
          const sp = pick(text);
          return { stop_reason: 'tool_use', usage: usage(420, 30), content: [{ type: 'tool_use', name: 'route', input: { specialist: sp, needs_check: sp !== 'helper', title: text.split(/\s+/).slice(0, 5).join(' ') } }] };
        }
        return { stop_reason: 'end_turn', usage: usage(900, 4), content: [{ type: 'text', text: 'OK' }] };
      },
      stream(params, opts) {
        const s = new EventEmitter();
        const who = /You are the (\w+)/.exec(params.system[0].text)?.[1]?.toLowerCase();
        const text = SAMPLE[{ coach: 'coach', teacher: 'teacher', summariser: 'summariser', planner: 'planner', writer: 'writer', data: 'data-helper' }[who]] ?? SAMPLE.helper;
        s.finalMessage = async () => {
          for (const part of text.match(/[\s\S]{1,12}/g)) {
            if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            await pause(90);
            s.emit('text', part, '');
          }
          return { stop_reason: 'end_turn', usage: usage(600, Math.round(text.length / 4)), content: [{ type: 'text', text }] };
        };
        return s;
      },
    },
  };
}
const jobs = [];
const controllers = new Map();
let nextJob = 1;
let hasKey = false;
function assistantSnapshot(now = Date.now()) {
  return {
    jobs: jobs.map((j) => ({ ...j, steps: undefined })),
    sessions: jobs.filter((j) => j.steps && (!j.endedAt || now - j.endedAt < 600000)).map((j) => toSession(j, now)),
  };
}
const assistantApi = {
  status: () => ({
    hasKey, keyHint: hasKey ? '…demo' : '', canStoreKey: true, prices: team.PRICES,
    levels: Object.fromEntries(Object.entries(team.LEVELS).map(([id, l]) => [id, { name: l.name, blurb: l.blurb }])),
    team: [...team.SPECIALISTS, team.CHECKER, { id: 'coach', name: 'Coach' }, { id: 'teacher', name: 'Teacher' }].map((a) => ({ name: a.id, title: a.name, room: roomFor(a.id) })),
    skills: team.SKILLS.map(({ id, name, blurb, placeholder, conversational }) => ({ id, name, blurb, placeholder, conversational: Boolean(conversational) })),
  }),
  'set-key': (k) => {
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(k).trim())) return { ok: false, error: 'That does not look like an Anthropic API key. Keys start with "sk-ant-".' };
    hasKey = true;
    return { ok: true, keyHint: '…demo' };
  },
  'clear-key': () => { hasKey = false; return { ok: true }; },
  check: (t) => ({ findings: findIdentifiers(t) }),
  reply: ({ id, text, confirmed }) => {
    const job = jobs.find((j) => j.id === String(id));
    if (!job?.turns || controllers.has(job.id)) return { ok: false, error: 'That task is still busy or no longer here.' };
    const findings = findIdentifiers(text);
    if (findings.length && confirmed !== true) return { ok: false, needsConfirm: true, findings };
    const c = new AbortController();
    controllers.set(job.id, c);
    continueTask(job, String(text).trim(), { client: fakeClient(), signal: c.signal }).finally(() => controllers.delete(job.id));
    return { ok: true };
  },
  run: ({ text, level, skill, confirmed }) => {
    const task = String(text ?? '').trim();
    if (!task) return { ok: false, error: 'Type a task first.' };
    const findings = findIdentifiers(task);
    if (findings.length && confirmed !== true) return { ok: false, needsConfirm: true, findings };
    const id = String(nextJob++);
    const c = new AbortController();
    controllers.set(id, c);
    jobs.push({ id, status: 'triage', text: task, level, startedAt: Date.now(), steps: [], tokens: { total: 0 }, answer: '' });
    runTask({ id, text: task, level, skill: skill || undefined }, {
      client: fakeClient(), signal: c.signal,
      onUpdate: (j) => { const i = jobs.findIndex((x) => x.id === id); if (i !== -1) jobs[i] = j; },
    }).finally(() => controllers.delete(id));
    return { ok: true, id };
  },
  stop: (id) => { controllers.get(String(id))?.abort(); return { ok: true }; },
  forget: (id) => { const i = jobs.findIndex((x) => x.id === String(id)); if (i !== -1) jobs.splice(i, 1); return { ok: true }; },
};

const root = path.join(__dirname, '..', 'renderer');
const port = Number(process.env.PORT) || 5178;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// The layout lives in memory here; the app keeps it in layout.json.
let layout = { departments: [], gardens: [] };
let decor = { rooms: {}, gardens: {} };
const config = () => ({
  rooms: roomsWith(layout), layout, departmentKinds: DEPARTMENT_KINDS, openCells: openCells(layout),
  gardens: gardensWith(layout),
  decor,
  decorCatalogue: {
    floors: D.FLOORS, defaultFloor: D.DEFAULT_FLOOR, spotsPerRoom: D.SPOTS_PER_ROOM, decorations: D.DECORATIONS,
    gardenSize: D.GARDEN_SIZE, plants: D.PLANTS, defaultGardens: D.DEFAULT_GARDENS,
  },
  platform: 'browser', version: 'preview',
});

const bridge = `export default {
  config: async () => (await fetch('/preview/config')).json(),
  saveLayout: async (layout) => (await fetch('/preview/layout', { method: 'POST', body: JSON.stringify(layout) })).json(),
  saveDecor: async (decor) => (await fetch('/preview/decor', { method: 'POST', body: JSON.stringify(decor) })).json(),
  assistant: Object.fromEntries(['status', 'setKey', 'clearKey', 'check', 'run', 'reply', 'stop', 'forget'].map((m) => [m,
    async (arg) => (await fetch('/preview/assistant/' + m.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), { method: 'POST', body: JSON.stringify(arg ?? null) })).json()])),
  // Only the Assistant's part of a snapshot; Monitor mode in the preview uses the demo.
  onSnapshot: (fn) => setInterval(async () => {
    const assistant = await (await fetch('/preview/assistant-snapshot')).json();
    fn({ sessions: [], stats: {}, watcher: { roots: [] }, roster: [], problems: [], assistant });
  }, 500),
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
          const ids = new Set(roomsWith(layout).map((r) => r.id));
          const plots = new Set(gardensWith(layout).map((g) => g.id));
          decor = {
            rooms: Object.fromEntries(Object.entries(decor.rooms).filter(([id]) => ids.has(id))),
            gardens: Object.fromEntries(Object.entries(decor.gardens).filter(([id]) => plots.has(id))),
          };
          out = { ok: true, config: config() };
        } catch (err) {
          out = { ok: false, error: err.message };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/preview/decor' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let out;
        try {
          const { decor: next, problems } = D.checkDecor(JSON.parse(body), roomsWith(layout), gardensWith(layout));
          if (problems.length) out = { ok: false, error: problems[0] };
          else {
            decor = next;
            out = { ok: true, decor };
          }
        } catch (err) {
          out = { ok: false, error: err.message };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/preview/assistant-snapshot') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(assistantSnapshot()));
      return;
    }
    if (url.pathname.startsWith('/preview/assistant/') && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const fn = assistantApi[url.pathname.slice('/preview/assistant/'.length)];
        res.writeHead(fn ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fn ? fn(JSON.parse(body || 'null')) : { ok: false, error: 'unknown' }));
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
