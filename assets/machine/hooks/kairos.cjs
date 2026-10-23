#!/usr/bin/env node
'use strict';

// kairos — session hook: prints the last update note (one line) and starts a detached daily update. Always exits 0.
const { spawn } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function startUpdate(selfupdate, adapter) {
  if (selfupdate.optedOut() || !selfupdate.due()) return;
  selfupdate.markChecked();
  spawn(process.execPath, [__filename, '--run', '--adapter', adapter], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function main() {
  const selfupdate = require('./lib/selfupdate.cjs');
  const adapter = (arg('--adapter') || 'claude').replace(/[^\w-]/g, '');
  if (process.argv.includes('--run')) {
    selfupdate.run({ background: true });
    return;
  }
  // Windsurf fires on every prompt: a stat of last-check, nothing printed.
  if (adapter !== 'windsurf') {
    const note = selfupdate.takeNote();
    if (note) process.stdout.write(`${adapter === 'cursor' ? JSON.stringify({ additional_context: note }) : note}\n`);
  }
  startUpdate(selfupdate, adapter);
}

try {
  main();
} catch {
  // a session must start even when the hook breaks
}
process.exit(0);
