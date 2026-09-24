#!/usr/bin/env node
'use strict';

// Command-line entry for the agent performance report, the same report the
// app opens from Settings. Options: --days N, --out DIR, --by-project.
const { run } = require('../src/report/agent-report.js');

try {
  run(process.argv.slice(2));
} catch (err) {
  console.error(`Could not build the report: ${err.message}`);
  process.exitCode = 1;
}
