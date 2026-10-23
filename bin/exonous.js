#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `exonous — the mind outside your head, for coding agents

Usage: exonous <command> [flags]

  install       wire every detected tool (Claude Code, Cursor) machine-wide; safe to re-run
                --dry-run  --quiet  --permissions  --tools a,b  --all  --skip-tool x
  update        move to the latest release                 --check: report only
  doctor        check every piece and say how to fix what is missing
  uninstall     remove exonous from this machine            --yes  --dry-run
  doctor/gate   exonous gate --selftest <tool>: pipe a fake git commit to the registered hook, expect a deny

  token <commit|push>    after review: allow one commit of the staged tree, or one push of HEAD (15 min)
  workflow <commit|pr>   print the commit or PR procedure
  template               print the PR template that applies here
  draft-path             print where to write this repo's PR body draft
  validate-pr <file>     check a PR body against the template

  setup is an alias of install. From a source checkout, install/uninstall need EXONOUS_HOME or --real-home.`;

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function value(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] || null;
}

const list = (name) => (value(name) ? value(name).split(',').map((s) => s.trim()).filter(Boolean) : null);
const arg = (i) => process.argv[3 + i];
const hooksLib = (name) => require(path.join(__dirname, '..', 'assets', 'machine', 'hooks', 'lib', name));

function runInstall() {
  if (process.argv[2] === 'setup' && process.env.npm_lifecycle_event === 'postinstall') {
    const decision = require('../src/lib/runtime').postinstallDecision(process.env);
    if (decision.action === 'skip') {
      console.log(`[exonous] postinstall skipped: ${decision.reason}`);
      return 0;
    }
  }
  require('../src/install').install({
    dryRun: flag('dry-run'), quiet: flag('quiet'), permissions: flag('permissions'), tools: list('tools'), all: flag('all'),
    skip: list('skip-tool') || [], realHome: flag('real-home'),
  });
  return 0;
}

function runGate() {
  const id = value('selftest');
  const { ADAPTERS, selftest } = require('../src/adapters');
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) {
    console.error(`usage: exonous gate --selftest <${ADAPTERS.map((a) => a.id).join('|')}>`);
    return 2;
  }
  const result = selftest(adapter);
  console.log(`${id}: ${result.detail}`);
  return result.ok ? 0 : 1;
}

function runToken() {
  const kind = arg(0);
  const token = hooksLib('token.cjs');
  if (!token.KINDS.includes(kind)) {
    console.error(`usage: exonous token <${token.KINDS.join('|')}>`);
    return 2;
  }
  const minted = token.mint(kind, process.cwd());
  const what = kind === 'commit' ? 'one commit of the staged tree' : 'one push of HEAD';
  console.log(`${kind} token minted: allows ${what} (${minted.sha.slice(0, 12)}), expires ${new Date(minted.exp).toLocaleTimeString()}.`);
  return 0;
}

function runTemplate() {
  const { resolveTemplate } = hooksLib('template.cjs');
  const template = resolveTemplate(process.cwd());
  if (!template.path) {
    console.error('no PR template found');
    return 1;
  }
  console.log(`${template.path}
`);
  process.stdout.write(fs.readFileSync(template.path, 'utf8'));
  return 0;
}

function runDraftPath() {
  const file = hooksLib('template.cjs').draftPath(process.cwd());
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  console.log(file);
  return 0;
}

function runValidatePr() {
  const file = arg(0);
  if (!file) {
    console.error('usage: exonous validate-pr <file>');
    return 2;
  }
  const { resolveTemplate } = hooksLib('template.cjs');
  const template = resolveTemplate(process.cwd());
  const result = hooksLib('pr-template-validate.cjs').validateBodyFile(file, process.cwd(), template);
  if (!result.ok) {
    console.error(result.reason);
    return 1;
  }
  console.log(`PR body OK — all ${template.sections.length} template titles present (${template.path}).`);
  return 0;
}

function writeNote(root, text) {
  const dir = path.join(root, '.claude', '.exonous');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note'), `${text}\n`);
}

function runUpdate() {
  const { update } = require('../src/update');
  const root = process.env.INIT_CWD || process.cwd();
  const background = flag('background');
  let result;
  try {
    result = update({ root, check: flag('check') });
  } catch (err) {
    const message = `exonous update failed: ${err.message} — run \`npx exonous update\` to retry`;
    if (background) writeNote(root, message);
    else console.error(message);
    return 1;
  }
  const messages = {
    absent: 'exonous is not a dependency of this project.',
    pinned: `pinned to "${result.from}" — not updating (remove the #ref to follow releases).`,
    'unknown-source': 'dependency source is not a git URL — update it with your package manager.',
    'no-release': 'no vX.Y.Z release tag found on the remote.',
    current: `up to date (v${result.to}).`,
    available: `update available: v${result.from || '?'} → v${result.to}.`,
    updated: result.from === result.to ? `exonous now follows release v${result.to}.` : `exonous updated v${result.from || '?'} → v${result.to}.`,
    busy: 'another update is running.',
  };
  if (background) {
    if (result.status === 'updated') writeNote(root, messages.updated);
  } else {
    console.log(messages[result.status]);
  }
  return 0;
}

const commands = {
  install: runInstall,
  setup: runInstall,
  update: runUpdate,
  doctor: () => require('../src/doctor').doctor(),
  uninstall: () => require('../src/uninstall').uninstall({ yes: flag('yes'), dryRun: flag('dry-run'), realHome: flag('real-home') }),
  gate: runGate,
  token: runToken,
  workflow: () => {
    require('../src/workflow').workflow(arg(0));
    return 0;
  },
  template: runTemplate,
  'draft-path': runDraftPath,
  'validate-pr': runValidatePr,
};

const command = process.argv[2];
if (!commands[command]) {
  console.log(USAGE);
  process.exit(command && !['help', '--help', '-h'].includes(command) ? 2 : 0);
}
Promise.resolve().then(() => commands[command]())
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    console.error(`exonous ${command}: ${err.message}`);
    process.exit(1);
  });
