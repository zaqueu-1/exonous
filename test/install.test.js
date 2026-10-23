#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const { install } = require('../src/install');
const { readLedger } = require('../src/lib/home');
const { readInstallInfo, SOURCE } = require('../src/lib/runtime');

let saved;
beforeEach(() => {
  saved = { home: process.env.EXONOUS_HOME, path: process.env.PATH };
  process.env.EXONOUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'install-home-'));
  process.env.PATH = path.dirname(process.execPath);
  fs.mkdirSync(path.join(process.env.EXONOUS_HOME, '.claude'));
});
afterEach(() => {
  for (const [key, value] of [['EXONOUS_HOME', saved.home], ['PATH', saved.path]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const home = (...p) => path.join(process.env.EXONOUS_HOME, ...p);
const run = (opts = {}) => install({ external: false, log: () => {}, ...opts });

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && !full.endsWith('install.json')) out[path.relative(dir, full)] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('runtime: hooks, template, rule variants and install.json land in ~/.claude/exonous', () => {
  run();
  for (const rel of ['hooks/pyle.cjs', 'hooks/lib/token.cjs', 'hooks/lib/release.cjs', 'hooks/lib/shell.cjs', 'PR-TEMPLATE.md', 'rules/nomos.md', 'rules/nomos.no-agents.md', 'rules/nomos.min.md']) {
    assert.ok(fs.existsSync(home('.claude', 'exonous', rel)), rel);
  }
  assert.ok(Buffer.byteLength(fs.readFileSync(home('.claude', 'exonous', 'rules', 'nomos.min.md'))) <= 3072);
  const info = readInstallInfo();
  assert.strictEqual(info.source, SOURCE);
  assert.strictEqual(SOURCE, 'https://github.com/zaqueu-1/exonous.git');
  for (const key of ['version', 'pm', 'packageRoot', 'installedAt']) assert.ok(info[key], key);
  assert.ok('tagSha' in info);
  assert.deepStrictEqual(Object.keys(info.tools), ['claude']);
  assert.ok(info.tools.claude.tier && info.tools.claude.version);
  assert.strictEqual(readLedger()['.claude/exonous/hooks/pyle.cjs'].tool, 'shared');
});

test('a second install changes nothing on disk', () => {
  fs.mkdirSync(home('.cursor'));
  run();
  const first = snapshot(process.env.EXONOUS_HOME);
  run();
  assert.deepStrictEqual(snapshot(process.env.EXONOUS_HOME), first);
});

test('dry run writes nothing', () => {
  const before = snapshot(process.env.EXONOUS_HOME);
  run({ dryRun: true });
  assert.deepStrictEqual(snapshot(process.env.EXONOUS_HOME), before);
});

test('files a release no longer ships are pruned; another tool\'s files survive a narrowed run', () => {
  fs.mkdirSync(home('.cursor'));
  run();
  const stale = home('.claude', 'exonous', 'hooks', 'lib', 'retired.cjs');
  fs.writeFileSync(stale, 'old\n');
  const ledgerFile = home('.claude', 'exonous', 'installed.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.files['.claude/exonous/hooks/lib/retired.cjs'] = { hash: crypto.createHash('sha256').update('old\n').digest('hex'), tool: 'shared' };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  run({ tools: ['claude'] });
  assert.ok(!fs.existsSync(stale), 'retired runtime file pruned');
  assert.ok(fs.existsSync(home('.cursor', 'rules', 'nomos.mdc')), 'cursor files kept when only claude ran');
});

test('install never writes into the repository it runs from', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'install-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, PATH: saved.path } });
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    run();
  } finally {
    process.chdir(cwd);
  }
  assert.deepStrictEqual(fs.readdirSync(repo), ['.git']);
});

// ── M3 revision: uninstall safety ────────────────────────────────────────────
const { uninstall } = require('../src/uninstall');
const { guardTarget, postinstallDecision } = require('../src/lib/runtime');

function foreignHome() {
  const files = {
    '.claude/settings.json': JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(make*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, 2),
    '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt' }] } }, null, 2),
    '.claude/rules/mine.md': '# my rule\n',
    '.claude/exonous/config.json': '{"autoUpdate":false}\n',
    '.claude/exonous/agent-roles/old-agent.md': '# role\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(home(rel)), { recursive: true });
    fs.writeFileSync(home(rel), content);
  }
  return files;
}

test('install → uninstall round trip restores foreign content and keeps user state', async () => {
  const files = foreignHome();
  run({ permissions: true });
  assert.ok(fs.existsSync(home('.claude', 'exonous', 'hooks', 'pyle.cjs')));
  const logs = [];
  assert.strictEqual(await uninstall({ yes: true, log: (m) => logs.push(m) }), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(home('.claude/settings.json'), 'utf8')), JSON.parse(files['.claude/settings.json']));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(home('.cursor/hooks.json'), 'utf8')), JSON.parse(files['.cursor/hooks.json']));
  for (const rel of ['.claude/rules/mine.md', '.claude/exonous/config.json', '.claude/exonous/agent-roles/old-agent.md']) {
    assert.strictEqual(fs.readFileSync(home(rel), 'utf8'), files[rel], rel);
  }
  for (const rel of ['hooks', 'install.json', 'installed.json', 'PR-TEMPLATE.md', 'rules', 'state', 'taxis.js', 'roster.json']) {
    assert.ok(!fs.existsSync(home('.claude', 'exonous', rel)), `${rel} removed`);
  }
  assert.ok(!fs.existsSync(home('.claude', 'rules', 'nomos.md')));
  assert.ok(logs.some((m) => m.includes('config.json') && m.includes('agent-roles')), 'tells the user what was kept');
});

test('uninstall --dry-run changes nothing', async () => {
  foreignHome();
  run();
  const before = snapshot(process.env.EXONOUS_HOME);
  await uninstall({ yes: true, dryRun: true, log: () => {} });
  assert.deepStrictEqual(snapshot(process.env.EXONOUS_HOME), before);
});

test('ledger paths that escape the home are never removed', async () => {
  run();
  const outside = path.join(path.dirname(process.env.EXONOUS_HOME), `escape-${path.basename(process.env.EXONOUS_HOME)}.txt`);
  fs.writeFileSync(outside, 'keep');
  const absolute = path.join(os.tmpdir(), `abs-${path.basename(process.env.EXONOUS_HOME)}.txt`);
  fs.writeFileSync(absolute, 'keep');
  const ledgerFile = home('.claude', 'exonous', 'installed.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.files[`../${path.basename(outside)}`] = { hash: 'x', tool: 'shared' };
  ledger.files[absolute] = { hash: 'x', tool: 'shared' };
  ledger.sections.push({ path: `../${path.basename(outside)}`, marker: 'html', hash: 'x', tool: 'claude' });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  const logs = [];
  await uninstall({ yes: true, log: (m) => logs.push(m) });
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.strictEqual(fs.readFileSync(absolute, 'utf8'), 'keep');
  assert.ok(logs.some((m) => /WARN/.test(m) && m.includes('outside')));
});

test('a dev checkout refuses to touch the real home unless asked', () => {
  const saved2 = { home: process.env.EXONOUS_HOME, HOME: process.env.HOME };
  const fakeReal = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-real-home-'));
  try {
    delete process.env.EXONOUS_HOME;
    process.env.HOME = fakeReal;
    assert.throws(() => guardTarget({ action: 'uninstall' }), /refusing to uninstall.*--real-home/s);
    assert.doesNotThrow(() => guardTarget({ action: 'uninstall', dryRun: true }));
    assert.doesNotThrow(() => guardTarget({ action: 'install', realHome: true }));
    process.env.EXONOUS_HOME = fakeReal;
    assert.throws(() => guardTarget({ action: 'install' }), /refusing/);
  } finally {
    process.env.EXONOUS_HOME = saved2.home;
    process.env.HOME = saved2.HOME;
  }
});

test('postinstall: CI and repo node_modules skip, global and explicit installs run', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const inRepo = path.join(real, 'app', 'node_modules', 'exonous');
  fs.mkdirSync(inRepo, { recursive: true });
  assert.strictEqual(postinstallDecision({ CI: '1' }, inRepo).action, 'skip');
  assert.strictEqual(postinstallDecision({ CONTINUOUS_INTEGRATION: 'true' }, inRepo).action, 'skip');
  assert.strictEqual(postinstallDecision({}, inRepo).action, 'skip');
  assert.strictEqual(postinstallDecision({ npm_config_global: 'true' }, inRepo).action, 'install');
  const bunGlobal = path.join(real, '.bun', 'install', 'global', 'node_modules', 'exonous');
  fs.mkdirSync(bunGlobal, { recursive: true });
  assert.strictEqual(postinstallDecision({}, bunGlobal).action, 'install');
  assert.strictEqual(postinstallDecision({}, path.join(__dirname, '..')).action, 'skip', 'dev checkout');
});
