'use strict';

// exonous install: machine-wide, idempotent. Shared pieces first, then every selected tool adapter, then prune.
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const { createHome } = require('./lib/home');
const { ensureAtlas } = require('./lib/atlas');
const { ensureBiblos } = require('./lib/biblos');
const { select } = require('./adapters');
const { ASSETS, DESIGN_SKILLS, packageVersion, installRuntime, writeInstallInfo, isolatedHome, guardTarget } = require('./lib/runtime');
const legacy = require('./legacy/bridge');

function defaultLog(msg) {
  process.stdout.write(`[exonous] ${msg}\n`);
}

function step(log, name, run) {
  try {
    run();
    return true;
  } catch (err) {
    log(`WARN: ${name} incomplete: ${err.message}`);
    return false;
  }
}

// Design skills ship an engine tree, so they are replaced whole instead of tracked file by file.
function installDesignStack(home, { dryRun, log }) {
  for (const name of DESIGN_SKILLS) {
    const dest = path.join(paths.home(), '.agents', 'skills', name);
    if (!dryRun) fs.rmSync(dest, { recursive: true, force: true });
    home.copyTree(path.join(ASSETS, 'skills', name), dest);
  }
  log(`design stack ${dryRun ? 'would be ' : ''}synced → ~/.agents/skills (${DESIGN_SKILLS.join(', ')})`);
}

/**
 * @param {{ dryRun?: boolean, quiet?: boolean, permissions?: boolean, tools?: string[] | null, all?: boolean, skip?: string[],
 *   external?: boolean, execPath?: string, log?: (msg: string) => void }} [options]
 * @returns {{ tools: string[] }}
 */
function install({
  dryRun = false, quiet = false, permissions = false, tools = null, all = false, skip = [],
  external = !isolatedHome(), execPath = process.execPath, realHome = false, log,
} = {}) {
  const emit = log || (quiet ? (msg) => { if (/^(WARN|target home)/.test(msg)) defaultLog(msg); } : defaultLog);
  guardTarget({ action: 'install', dryRun, realHome, log: emit });
  const { selected, detected } = select({ tools, all, skip });
  if (!selected.length) emit('WARN: no supported tool found (Claude Code, Cursor) — only shared pieces installed; rerun after installing one');
  const home = createHome({ dryRun, log: emit, previous: legacy.previousLedger() });
  step(emit, 'legacy cleanup', () => legacy.migrateHome({ dryRun, log: emit, home }));
  step(emit, 'atlas', () => {
    if (!external) emit('atlas skipped: EXONOUS_HOME is not the real home');
    else if (!ensureAtlas({ dryRun }).ok) emit('WARN: atlas not installed — run `exonous doctor` for the manual command');
  });
  step(emit, 'biblos', () => ensureBiblos({ dryRun }));
  step(emit, 'design stack', () => installDesignStack(home, { dryRun, log: emit }));
  if (!step(emit, 'runtime', () => installRuntime(home))) home.ledger.complete = false;
  const ctx = { home, dryRun, log: emit, execPath, permissions, external, detected };
  for (const adapter of selected) {
    if (!step(emit, adapter.id, () => adapter.install(ctx))) home.ledger.complete = false;
  }
  writeInstallInfo({ tools: Object.fromEntries(selected.map((a) => [a.id, a])), dryRun });
  home.prune(packageVersion(), { tools: selected.map((a) => a.id) });
  emit(`install ${dryRun ? 'dry run ' : ''}done (v${packageVersion()}) — ${selected.map((a) => a.id).join(', ') || 'no tools'}`);
  return { tools: selected.map((a) => a.id) };
}

module.exports = { install, isolatedHome };
