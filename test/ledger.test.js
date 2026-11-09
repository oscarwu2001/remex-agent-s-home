'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLedger, timeOf } = require('../src/core/ledger');

const HEAD = 'timestamp\tproject\tsession\tagent\tagent_id\tsha\tverdict\tfindings\tblocking\toutcome\tevidence';
function ledger(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ledger-'));
  fs.mkdirSync(path.join(dir, 'verdict-ledger'));
  fs.writeFileSync(path.join(dir, 'verdict-ledger', 'verdicts.tsv'), [HEAD, ...rows].join('\n') + '\n');
  return dir;
}
const row = (t, agent, verdict, outcome = '') => [t, 'demo', 's1', agent, 'a1', 'abc1234', verdict, '1', verdict === 'FAIL' ? '1' : '0', outcome, outcome ? 'invented check' : ''].join('\t');

test('the ledger is counted per agent: verdicts, FAIL outcomes, missed PASSes, missing lines', () => {
  const dir = ledger([
    row('2026-11-05T10:00:00+0800', 'reviewer', 'FAIL', 'real'),
    row('2026-11-05T11:00:00+0800', 'reviewer', 'FAIL', 'false-alarm'),
    row('2026-11-05T12:00:00+0800', 'reviewer', 'FAIL'),
    row('2026-11-05T13:00:00+0800', 'reviewer', 'PASS', 'missed'),
    row('2026-11-05T14:00:00+0800', 'silent-failure-hunter', 'MISSING'),
    'not a row at all',
  ]);
  const res = readLedger([dir]);
  assert.equal(res.found, 1);
  assert.deepEqual(res.agents.reviewer, { rows: 4, PASS: 1, FAIL: 3, BLOCKED: 0, MISSING: 0, UNREAD: 0, real: 1, unverified: 0, falseAlarm: 1, open: 1, missed: 1 });
  assert.equal(res.agents['silent-failure-hunter'].MISSING, 1);
  assert.match(res.problems.join(), /1 row of the verdict ledger could not be read/);
  assert.ok(!JSON.stringify(res).includes('abc1234') && !JSON.stringify(res).includes('invented check'), 'commits and evidence are never kept');
});

test('rows outside the period are left out; no ledger is not a problem', () => {
  const dir = ledger([row('2026-10-01T10:00:00+0800', 'reviewer', 'PASS'), row('2026-11-05T10:00:00+0800', 'reviewer', 'PASS')]);
  const res = readLedger([dir], { since: timeOf('2026-11-01T00:00:00+0800') });
  assert.equal(res.agents.reviewer.rows, 1);
  const none = readLedger([fs.mkdtempSync(path.join(os.tmpdir(), 'agents-noledger-'))]);
  assert.deepEqual([none.found, none.problems], [0, []]);
});
