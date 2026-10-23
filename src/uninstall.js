'use strict';

// exonous uninstall: removes only what install wrote; MCP registrations, config.json and agent-roles stay (they are the user's).
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const readline = require('readline');
const { createHome, readLedgerFile, ledgerPath, contained } = require('./lib/home');
const { stripOwned } = require('./lib/settings');
const { removePlugins, PLUGIN_ID, MARKETPLACE } = require('./lib/techne');
const { DESIGN_SKILLS, PACKAGE_ROOT, isolatedHome, guardTarget } = require('./lib/runtime');
const { ADAPTERS } = require('./adapters');

// Runtime pieces exonous ships into ~/.claude/exonous; everything else there belongs to the user.
const RUNTIME = ['hooks', 'rules', 'state', 'PR-TEMPLATE.md', 'taxis.js', 'roster.json', 'install.json'];
const KEPT = ['config.json', 'agent-roles'];

function defaultLog(msg) {
  process.stdout.write(`[exonous] ${msg}\n`);
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(/^y(es)?$/i.test(answer.trim()));
  }));
}

function removeMachine(home, { dryRun, log }) {
  const ledger = readLedgerFile(ledgerPath()) || {};
  for (const adapter of ADAPTERS) adapter.uninstall({ dryRun, log });
  const taxis = '/.claude/exonous/taxis.js';
  stripOwned(path.join(paths.claudeDir(), 'settings.json'), { format: 'claude', ownedMarker: taxis, dryRun, log });
  stripOwned(path.join(paths.cursorDir(), 'hooks.json'), { format: 'cursor', ownedMarker: taxis, dryRun, log });
  for (const entry of ledger.sections || []) home.removeSection(entry);
  for (const rel of Object.keys(ledger.files || {})) {
    const abs = contained(rel);
    if (!abs) {
      log(`WARN: ledger entry ${rel} points outside the home — left alone`);
      continue;
    }
    home.remove(abs);
    if (fs.existsSync(`${abs}.bak`)) log(`kept your backup ~/${rel}.bak`);
  }
  for (const base of ['.claude', '.cursor']) {
    const dir = path.join(paths.home(), base, 'agents');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^exo-.+\.md$/.test(f)) home.remove(path.join(dir, f));
    home.remove(path.join(paths.home(), base, 'skills', 'ui-patterns'));
  }
  for (const name of DESIGN_SKILLS) {
    home.remove(path.join(paths.home(), '.agents', 'skills', name));
    for (const base of ['.claude', '.cursor', '.github']) home.remove(path.join(paths.home(), base, 'skills', name));
  }
  if (!isolatedHome() && !dryRun) removePlugins([PLUGIN_ID], [MARKETPLACE], { log });
  home.remove(path.join(paths.claudeDir(), 'techne'));
  for (const rel of RUNTIME) home.remove(path.join(paths.exoDir(), rel));
  home.remove(ledgerPath());
  const left = fs.existsSync(paths.exoDir()) ? fs.readdirSync(paths.exoDir()) : [];
  if (!left.length && !dryRun) fs.rmSync(paths.exoDir(), { recursive: true, force: true });
  else if (left.length) log(`kept ${KEPT.map((k) => `~/.claude/exonous/${k}`).join(' and ')} (yours; delete by hand if unwanted)`);
}

/** @param {{ yes?: boolean, dryRun?: boolean, realHome?: boolean, log?: (msg: string) => void }} [options] */
async function uninstall({ yes = false, dryRun = false, realHome = false, log = defaultLog } = {}) {
  guardTarget({ action: 'uninstall', dryRun, realHome, log });
  if (!yes && !dryRun && !(await confirm(`Remove exonous from ${paths.home()}? [y/N] `))) {
    log('nothing removed');
    return 1;
  }
  removeMachine(createHome({ dryRun, log }), { dryRun, log });
  const pm = paths.detectPm(process.env, PACKAGE_ROOT);
  log(`${dryRun ? 'dry run done. ' : ''}last step: ${pm} ${pm === 'npm' ? 'uninstall' : 'remove'} -g exonous`);
  log('kept: atlas/biblos MCP registrations and your skill config files');
  return 0;
}

module.exports = { uninstall };
