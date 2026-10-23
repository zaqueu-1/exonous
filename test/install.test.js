#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const { isolatedPath } = require('./helpers/adapter-fixture');
const { install } = require('../src/install');
const { readLedger } = require('../src/lib/home');
const { readInstallInfo, SOURCE, stageDir } = require('../src/lib/runtime');

let saved;
beforeEach(() => {
  saved = { home: process.env.EXONOUS_HOME, path: process.env.PATH };
  process.env.EXONOUS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'install-home-'));
  process.env.PATH = isolatedPath();
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

test('kairos is registered once per tool at session start, beside foreign session hooks', () => {
  fs.mkdirSync(home('.cursor'));
  const foreign = { hooks: [{ type: 'command', command: 'my-session-banner' }] };
  fs.writeFileSync(home('.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [foreign] } }));
  fs.writeFileSync(home('.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'my-cursor-start' }] } }));
  run({ execPath: '/opt/node 20/bin/node' });
  run({ execPath: '/opt/node 20/bin/node' });
  const kairos = `"${home('.claude', 'exonous', 'hooks', 'kairos.cjs')}"`;
  const claude = JSON.parse(fs.readFileSync(home('.claude', 'settings.json'), 'utf8')).hooks.SessionStart;
  assert.deepStrictEqual(claude[0], foreign);
  assert.deepStrictEqual(claude.filter((e) => JSON.stringify(e).includes('kairos')), [{ hooks: [{ type: 'command', command: `"/opt/node 20/bin/node" ${kairos} --adapter claude` }] }]);
  const cursor = JSON.parse(fs.readFileSync(home('.cursor', 'hooks.json'), 'utf8')).hooks.sessionStart;
  assert.deepStrictEqual(cursor[0], { command: 'my-cursor-start' });
  assert.deepStrictEqual(cursor.filter((e) => e.command.includes('kairos')), [{ command: `"/opt/node 20/bin/node" ${kairos} --adapter cursor` }]);
});

test('a reinstall of the same version keeps the recorded tag; a non-tag pin survives any version', () => {
  run();
  const file = home('.claude', 'exonous', 'install.json');
  fs.writeFileSync(file, JSON.stringify({ ...readInstallInfo(), ref: 'v9.9.9', tagSha: 'b'.repeat(40) }));
  run();
  assert.deepStrictEqual([readInstallInfo().ref, readInstallInfo().tagSha], ['v9.9.9', 'b'.repeat(40)]);
  fs.writeFileSync(file, JSON.stringify({ ...readInstallInfo(), version: '0.0.1', ref: 'v0.0.1' }));
  run();
  assert.deepStrictEqual([readInstallInfo().ref, readInstallInfo().tagSha], [undefined, null]);
  fs.writeFileSync(file, JSON.stringify({ ...readInstallInfo(), version: '0.0.1', ref: 'main' }));
  run();
  assert.strictEqual(readInstallInfo().ref, 'main');
});

test('hooks are staged in a sibling dir and swapped in whole; a failed stage keeps the previous hooks', () => {
  run();
  const hooks = home('.claude', 'exonous', 'hooks');
  fs.writeFileSync(path.join(hooks, 'dropped-by-release.cjs'), 'old');
  run();
  assert.ok(!fs.existsSync(path.join(hooks, 'dropped-by-release.cjs')), 'the whole dir is replaced');
  assert.ok(fs.existsSync(path.join(hooks, 'kairos.cjs')));
  assert.deepStrictEqual(fs.readdirSync(home('.claude', 'exonous')).filter((n) => /^hooks\./.test(n)), [], 'no staging leftovers');
  const before = fs.readFileSync(path.join(hooks, 'pyle.cjs'), 'utf8');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-src-'));
  fs.writeFileSync(path.join(src, 'pyle.cjs'), 'new');
  assert.throws(() => stageDir(src, ['pyle.cjs', 'missing.cjs'], hooks));
  assert.strictEqual(fs.readFileSync(path.join(hooks, 'pyle.cjs'), 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(home('.claude', 'exonous')).filter((n) => /^hooks\./.test(n)), []);
});

test('install.json records the pm binary found on PATH', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bin-'));
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const saved = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = 'npm/10.0.0 node/v20';
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = saved;
  }
  assert.strictEqual(readInstallInfo().pm, 'npm');
  assert.strictEqual(readInstallInfo().pmPath, path.join(bin, 'npm'));
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

test('postinstall: CI skips, a repo node_modules copy migrates, global and explicit installs run', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const inRepo = path.join(real, 'app', 'node_modules', 'exonous');
  fs.mkdirSync(inRepo, { recursive: true });
  assert.strictEqual(postinstallDecision({ CI: '1' }, inRepo).action, 'skip');
  assert.strictEqual(postinstallDecision({ CONTINUOUS_INTEGRATION: 'true' }, inRepo).action, 'skip');
  assert.strictEqual(postinstallDecision({}, inRepo).action, 'migrate');
  assert.strictEqual(postinstallDecision({ npm_config_global: 'true' }, inRepo).action, 'install');
  const bunGlobal = path.join(real, '.bun', 'install', 'global', 'node_modules', 'exonous');
  fs.mkdirSync(bunGlobal, { recursive: true });
  assert.strictEqual(postinstallDecision({}, bunGlobal).action, 'install');
  assert.strictEqual(postinstallDecision({}, path.join(__dirname, '..')).action, 'skip', 'dev checkout');
});

test('a CLI install into a fixture home with every tool dir never touches os.homedir(); doctor self-tests each gate', () => {
  const { spawnSync } = require('child_process');
  const osHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-oshome-'));
  for (const dir of ['.claude', '.cursor', '.gemini', '.codex', '.config/opencode']) fs.mkdirSync(home(dir), { recursive: true });
  const env = { ...process.env, HOME: osHome, USERPROFILE: osHome, EXONOUS_HOME: process.env.EXONOUS_HOME, PATH: process.env.PATH, EXONOUS_NO_UPDATE: '1' };
  delete env.EXONOUS_TEST;
  const bin = path.join(__dirname, '..', 'bin', 'exonous.js');
  const res = spawnSync(process.execPath, [bin, 'install', '--quiet'], { env, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(fs.readdirSync(osHome), [], 'os.homedir() untouched');
  assert.deepStrictEqual(Object.keys(readInstallInfo().tools), ['claude', 'cursor', 'gemini', 'codex', 'opencode']);
  const doctor = spawnSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' }).stdout;
  for (const id of ['claude', 'cursor', 'gemini', 'codex', 'opencode']) assert.match(doctor, new RegExp(`✓ ${id}: gate self-test`), doctor);
  assert.match(doctor, /⚠ Codex CLI: gate approved in \/hooks \(pending/);
  assert.match(doctor, /⚠ Cursor: User Rules/);
  for (const label of ['Gemini CLI: gate hook', 'Codex CLI: gate hook registered', 'OpenCode: gate plugin']) assert.ok(doctor.includes(`✓ ${label}`), label);
  assert.deepStrictEqual(fs.readdirSync(osHome), []);
});

test('doctor: warn-level rows show ⚠ with their fix and never fail the run', () => {
  const { report } = require('../src/doctor');
  const ok = { name: 'a', ok: true, fix: 'x' };
  const warn = { name: 'b', ok: false, level: 'warn', status: 'pending', fix: 'approve it' };
  const bad = { name: 'c', ok: false, fix: 'install' };
  const onlyWarn = report([ok, warn]);
  assert.strictEqual(onlyWarn.failed, 0);
  assert.strictEqual(onlyWarn.warned, 1);
  assert.match(onlyWarn.text, /⚠ b \(pending\)\n {6}fix: approve it/);
  assert.match(onlyWarn.text, /All good \(1 warning\)\./);
  const withBad = report([ok, warn, bad]);
  assert.strictEqual(withBad.failed, 1);
  assert.match(withBad.text, /✗ c\n {6}fix: install/);
});


test('a fixture home with all ten tools: doctor shows every tool with the right level', () => {
  const { spawnSync } = require('child_process');
  const osHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-oshome-'));
  for (const dir of ['.cursor', '.gemini', '.codex', '.config/opencode', '.codeium/windsurf/memories', '.copilot', 'Documents/Cline', '.qwen', '.kiro']) fs.mkdirSync(home(dir), { recursive: true });
  fs.writeFileSync(home('.codeium', 'windsurf', 'hooks.json'), '{}\n');
  fs.writeFileSync(home('.codeium', 'windsurf', 'memories', 'global_rules.md'), '');
  fs.writeFileSync(home('.aider.conf.yml'), 'model: x\n');
  const env = { ...process.env, HOME: osHome, USERPROFILE: osHome, EXONOUS_NO_UPDATE: '1' };
  delete env.EXONOUS_TEST;
  const bin = path.join(__dirname, '..', 'bin', 'exonous.js');
  const res = spawnSync(process.execPath, [bin, 'install', '--quiet'], { env, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /⚠ cline: rules only — commits are NOT gated/);
  assert.match(res.stdout, /⚠ aider: unsupported — /);
  const doctor = spawnSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' }).stdout;
  assert.match(doctor, /^exonous v[\d.]+ — gated: claude, cursor, gemini, codex, opencode, windsurf, copilot; rules only: cline, qwen; detected: kiro; unsupported: aider\n/);
  assert.match(doctor, /\nCommits gated in 7 tools; NOT gated in 4: cline, qwen, kiro, aider\.\n/);
  for (const id of ['claude', 'cursor', 'gemini', 'codex', 'opencode', 'windsurf', 'copilot']) assert.match(doctor, new RegExp(`✓ ${id}: gate self-test \\(script self-test`), id);
  for (const label of ['Cline: gate', 'Qwen Code: gate', 'Kiro: gate']) assert.match(doctor, new RegExp(`⚠ ${label} \\(soft: not enforced`), label);
  for (const label of ['Windsurf: gate hook', 'Windsurf: nomos min rules', 'Copilot: gate hook \\(Preview\\)', 'Cline: nomos rules', 'Qwen Code: nomos rules']) assert.match(doctor, new RegExp(`✓ ${label}`), label);
  assert.match(doctor, /⚠ Aider: unsupported/);
  assert.match(doctor, /⚠ Codex CLI: gate approved in \/hooks/);
  assert.ok(!/✗ (cline|qwen|kiro|aider): gate self-test/.test(doctor), 'soft and unsupported tools get no self-test');
  assert.deepStrictEqual(fs.readdirSync(osHome), []);
});
