// Records the fingerprint of every Office pack file as shipped, in
// office-pack/versions.json. "Update agents" replaces an installed file only
// when it matches one of these, so a file the user edited is never touched.
// Run after changing anything in office-pack/ (a test checks it was run):
//   node scripts/pack-versions.js
// With git refs as arguments it also records the files as they were then.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fingerprint, packFiles } = require('../src/core/officepack');

const PACK = path.join(__dirname, '..', 'office-pack');
const FILE = path.join(PACK, 'versions.json');
const versions = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const add = (rel, text) => {
  const list = (versions[rel] ??= []);
  const h = fingerprint(text);
  if (!list.includes(h)) list.push(h);
};

for (const ref of process.argv.slice(2)) {
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'office-pack'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const name of names) {
    const rel = path.relative('office-pack', name).split(path.sep).join('/');
    if (rel === 'versions.json' || rel === 'README.md') continue;
    add(rel, execFileSync('git', ['show', `${ref}:${name}`], { encoding: 'utf8' }));
  }
}
for (const rel of packFiles(PACK)) add(rel, fs.readFileSync(path.join(PACK, rel), 'utf8'));

const sorted = Object.fromEntries(Object.keys(versions).sort().map((k) => [k, versions[k]]));
fs.writeFileSync(FILE, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} files recorded in office-pack/versions.json`);
