#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { mergeOwned, mergeKey, stripOwned } = require('../src/lib/settings');

const OWNED = '/.claude/exonous/hooks/';
const ours = (event) => `node "$HOME/.claude/exonous/hooks/pyle.cjs" ${event}`;

function fixture(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, name);
  if (value !== undefined) fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return { dir, file, logs: [], read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const userClaude = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
};

const claudeEntries = (cmd = ours('gate')) => ({
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: ours('kairos') }] }],
});

test('owned hooks are appended and foreign entries stay untouched', () => {
  const fx = fixture('settings.json', userClaude);
  const res = mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED, log: (m) => fx.logs.push(m) });
  assert.strictEqual(res.status, 'written');
  const out = fx.read();
  assert.strictEqual(out.model, 'opus');
  assert.deepStrictEqual(out.hooks.Stop, userClaude.hooks.Stop);
  assert.deepStrictEqual(out.hooks.PreToolUse[0], userClaude.hooks.PreToolUse[0]);
  assert.strictEqual(out.hooks.PreToolUse.length, 2);
  assert.strictEqual(out.hooks.SessionStart.length, 1);
});

test('a rerun replaces owned entries instead of duplicating them', () => {
  const fx = fixture('settings.json', userClaude);
  mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED });
  const first = fs.readFileSync(fx.file, 'utf8');
  assert.strictEqual(mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED }).status, 'unchanged');
  assert.strictEqual(fs.readFileSync(fx.file, 'utf8'), first);
  mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(`${ours('gate')} --v2`), ownedMarker: OWNED });
  const pre = fx.read().hooks.PreToolUse;
  assert.strictEqual(pre.length, 2);
  assert.match(pre[1].hooks[0].command, /--v2$/);
});

test('invalid JSON aborts that file with a warning and leaves it byte-identical', () => {
  const broken = '{ "hooks": { oops }\n';
  const fx = fixture('settings.json', broken);
  const res = mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED, log: (m) => fx.logs.push(m) });
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(fs.readFileSync(fx.file, 'utf8'), broken);
  assert.ok(fx.logs.some((m) => m.startsWith('WARN') && m.includes(fx.file)));
  assert.ok(!fs.existsSync(`${fx.file}.exonous.bak`));
});

test('hooks that are not an object abort instead of being replaced', () => {
  const fx = fixture('settings.json', { hooks: ['weird'] });
  const res = mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED, log: (m) => fx.logs.push(m) });
  assert.strictEqual(res.status, 'invalid');
  assert.deepStrictEqual(fx.read(), { hooks: ['weird'] });
});

test('the first change keeps one backup of the original and later runs never overwrite it', () => {
  const fx = fixture('settings.json', userClaude);
  const original = fs.readFileSync(fx.file, 'utf8');
  mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED });
  mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(`${ours('gate')} --v2`), ownedMarker: OWNED });
  assert.strictEqual(fs.readFileSync(`${fx.file}.exonous.bak`, 'utf8'), original);
  assert.deepStrictEqual(fs.readdirSync(fx.dir).sort(), ['settings.json', 'settings.json.exonous.bak']);
});

test('a missing file is created in the tool format without a backup', () => {
  const fx = fixture('hooks.json');
  mergeOwned(fx.file, { format: 'cursor', entries: { preToolUse: [{ command: ours('gate'), matcher: 'Shell' }] }, ownedMarker: OWNED });
  assert.deepStrictEqual(fx.read(), { version: 1, hooks: { preToolUse: [{ command: ours('gate'), matcher: 'Shell' }] } });
  assert.ok(!fs.existsSync(`${fx.file}.exonous.bak`));
});

test('dry run reports the change and writes nothing', () => {
  const fx = fixture('settings.json', userClaude);
  const before = fs.readFileSync(fx.file, 'utf8');
  const res = mergeOwned(fx.file, { format: 'gemini', entries: claudeEntries(), ownedMarker: OWNED, dryRun: true, log: (m) => fx.logs.push(m) });
  assert.strictEqual(res.status, 'written');
  assert.strictEqual(fs.readFileSync(fx.file, 'utf8'), before);
  assert.ok(fx.logs.some((m) => m.startsWith('DRY')));
});

test('stripOwned removes only owned entries and drops events it emptied', () => {
  const fx = fixture('hooks.json', {
    version: 1,
    hooks: {
      pre_run_command: [{ command: 'mine' }, { command: ours('gate') }],
      post_write_code: [{ command: ours('post') }],
    },
  });
  assert.strictEqual(stripOwned(fx.file, { format: 'windsurf', ownedMarker: OWNED }).status, 'written');
  assert.deepStrictEqual(fx.read(), { version: 1, hooks: { pre_run_command: [{ command: 'mine' }] } });
  assert.strictEqual(stripOwned(path.join(fx.dir, 'absent.json'), { format: 'windsurf', ownedMarker: OWNED }).status, 'absent');
});

test('format is validated', () => {
  const fx = fixture('settings.json', {});
  assert.throws(() => mergeOwned(fx.file, { format: 'vim', entries: {}, ownedMarker: OWNED }), /format/);
});

test('mergeKey owns map entries by key and leaves the rest alone', () => {
  const fx = fixture('settings.json', { theme: 'dark', mcpServers: { mine: { command: 'x' }, atlas: { command: 'old' } } });
  const atlas = { command: 'atlas', args: ['serve'] };
  assert.strictEqual(mergeKey(fx.file, { key: 'mcpServers', entries: { atlas, biblos: { url: 'https://example.test/mcp' } } }).status, 'written');
  assert.deepStrictEqual(fx.read(), { theme: 'dark', mcpServers: { mine: { command: 'x' }, atlas, biblos: { url: 'https://example.test/mcp' } } });
  assert.strictEqual(mergeKey(fx.file, { key: 'mcpServers', entries: { atlas } }).status, 'unchanged');
  mergeKey(fx.file, { key: 'mcp', entries: { biblos: null } });
  mergeKey(fx.file, { key: 'mcpServers', entries: { biblos: null } });
  assert.deepStrictEqual(Object.keys(fx.read().mcpServers), ['mine', 'atlas']);
});

test('mergeKey never writes a removal into a missing file', () => {
  const fx = fixture('mcp.json');
  assert.strictEqual(mergeKey(fx.file, { key: 'mcp', entries: { atlas: null } }).status, 'absent');
  assert.ok(!fs.existsSync(fx.file));
});

test('a BOM-prefixed file is merged and keeps its BOM', () => {
  const fx = fixture('settings.json', `\uFEFF${JSON.stringify(userClaude)}`);
  assert.strictEqual(mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED }).status, 'written');
  const raw = fs.readFileSync(fx.file, 'utf8');
  assert.ok(raw.startsWith('\uFEFF{'));
  assert.strictEqual(JSON.parse(raw.slice(1)).hooks.PreToolUse.length, 2);
});

test('commented JSON stays refused', () => {
  const fx = fixture('settings.json', '{\n  // mine\n  "a": 1\n}\n');
  assert.strictEqual(mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED, log: () => {} }).status, 'invalid');
});

test('Windows-style hook paths are still recognised as owned', () => {
  const win = 'node "C:\\Users\\u\\.claude\\exonous\\hooks\\pyle.cjs" gate';
  const fx = fixture('settings.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: win }] }] } });
  mergeOwned(fx.file, { format: 'claude', entries: claudeEntries(), ownedMarker: OWNED });
  const pre = fx.read().hooks.PreToolUse;
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].hooks[0].command, ours('gate'));
  const fx2 = fixture('settings.json', { hooks: { PreToolUse: [{ command: ours('gate') }] } });
  stripOwned(fx2.file, { format: 'claude', ownedMarker: '\\.claude\\exonous\\hooks\\' });
  assert.deepStrictEqual(fx2.read(), { hooks: {} });
});
