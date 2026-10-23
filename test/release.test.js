#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('node:test');
const { RELEASE_REF, compareVersions, latestRelease } = require('../src/lib/release');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function bareRepo(tags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, ['init', '-q']);
  const shas = {};
  for (const tag of tags) {
    fs.writeFileSync(path.join(work, 'f.txt'), tag);
    git(work, ['add', 'f.txt']);
    git(work, ['commit', '-q', '-m', tag]);
    git(work, ['tag', tag]);
    shas[tag] = git(work, ['rev-parse', 'HEAD']);
  }
  const bare = path.join(dir, 'repo.git');
  git(dir, ['clone', '-q', '--bare', work, bare]);
  return { url: `file://${bare}`, shas, dir };
}

function withSource(value, fn) {
  const prev = process.env.EXONOUS_RELEASE_SOURCE;
  if (value === undefined) delete process.env.EXONOUS_RELEASE_SOURCE;
  else process.env.EXONOUS_RELEASE_SOURCE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.EXONOUS_RELEASE_SOURCE;
    else process.env.EXONOUS_RELEASE_SOURCE = prev;
  }
}

test('only plain vX.Y.Z tags are releases', () => {
  assert.ok(RELEASE_REF.test('v2.10.3'));
  for (const ref of ['2.0.0', 'v2.0', 'v2.0.0-rc.1', 'main', 'v2.0.0x']) assert.ok(!RELEASE_REF.test(ref), ref);
});

test('versions compare numerically, not lexically', () => {
  assert.ok(compareVersions([1, 10, 0], [1, 9, 9]) > 0);
  assert.ok(compareVersions([2, 0, 0], [1, 99, 99]) > 0);
  assert.strictEqual(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('the highest release tag wins and carries its commit sha', () => {
  const { url, shas } = bareRepo(['v1.2.0', 'v1.10.0', 'v1.9.5', 'v2.1.0-rc.1', 'notes']);
  withSource(undefined, () => {
    assert.deepStrictEqual(latestRelease(url), { version: '1.10.0', sha: shas['v1.10.0'] });
  });
});

test('a major filter keeps the update inside that major', () => {
  const { url, shas } = bareRepo(['v1.4.0', 'v2.0.0', 'v2.3.1', 'v3.0.0']);
  withSource(undefined, () => {
    assert.deepStrictEqual(latestRelease(url, { major: 2 }), { version: '2.3.1', sha: shas['v2.3.1'] });
    assert.strictEqual(latestRelease(url, { major: 4 }), null);
    assert.strictEqual(latestRelease(url).version, '3.0.0');
  });
});

test('a repo without release tags has no latest release', () => {
  const { url } = bareRepo(['notes', 'v1.0']);
  withSource(undefined, () => assert.strictEqual(latestRelease(url), null));
});

test('EXONOUS_RELEASE_SOURCE replaces the given url', () => {
  const { url, shas } = bareRepo(['v5.0.0']);
  withSource(url, () => {
    assert.deepStrictEqual(latestRelease('https://example.invalid/nowhere.git'), { version: '5.0.0', sha: shas['v5.0.0'] });
  });
});

test('a url shaped like an option is never parsed as one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-opt-'));
  const marker = path.join(dir, 'pwned');
  withSource(undefined, () => {
    assert.throws(() => latestRelease(`--upload-pack=touch ${marker}`));
  });
  assert.ok(!fs.existsSync(marker));
});
