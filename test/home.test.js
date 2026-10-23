#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { createHome, homeRel, readLedger, sha256 } = require('../src/lib/home');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const src = path.join(dir, 'src.md');
  const dest = path.join(dir, 'dest.md');
  fs.writeFileSync(src, 'release v2\n');
  return { src, dest, logs: [] };
}

test('a user-edited file is backed up before it is replaced', () => {
  const { src, dest, logs } = sandbox();
  fs.writeFileSync(dest, 'my edits\n');
  const home = createHome({ log: (m) => logs.push(m), previous: { [homeRel(dest)]: sha256('release v1\n') } });
  home.sync(src, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'release v2\n');
  assert.strictEqual(fs.readFileSync(`${dest}.bak`, 'utf8'), 'my edits\n');
});

test('an untouched file from the previous release is replaced without a backup', () => {
  const { src, dest, logs } = sandbox();
  fs.writeFileSync(dest, 'release v1\n');
  const home = createHome({ log: (m) => logs.push(m), previous: { [homeRel(dest)]: sha256('release v1\n') } });
  home.sync(src, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'release v2\n');
  assert.ok(!fs.existsSync(`${dest}.bak`));
});

test('a missing source marks the ledger incomplete instead of throwing', () => {
  const { dest, logs } = sandbox();
  const home = createHome({ log: (m) => logs.push(m), previous: {} });
  home.sync(path.join(path.dirname(dest), 'missing.md'), dest);
  assert.strictEqual(home.ledger.complete, false);
  assert.ok(logs.some((m) => m.includes('not synced')));
});

test('EXONOUS_HOME set after load moves the ledger and home-relative paths', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'home-env-'));
  const prev = process.env.EXONOUS_HOME;
  process.env.EXONOUS_HOME = fake;
  try {
    const ledger = path.join(fake, '.claude', 'exonous', 'installed.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({ files: { '.claude/x.md': 'abc' } }));
    assert.deepStrictEqual(readLedger(), { '.claude/x.md': 'abc' });
    assert.strictEqual(homeRel(path.join(fake, '.claude', 'x.md')), '.claude/x.md');
  } finally {
    if (prev === undefined) delete process.env.EXONOUS_HOME;
    else process.env.EXONOUS_HOME = prev;
  }
});
