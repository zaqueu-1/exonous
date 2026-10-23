'use strict';

// What exonous ships and where its machine runtime lives: ~/.claude/exonous/{hooks,PR-TEMPLATE.md,rules,install.json}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const { renderRules, VARIANTS } = require('./render-rules');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(PACKAGE_ROOT, 'assets');
const SOURCE = 'https://github.com/zaqueu-1/exonous.git';
const OWNED_MARKER = '/.claude/exonous/hooks/';
const COMMANDS = ['commit-changes', 'make-pr', 'code-review', 'security-review'];
// Code files only — config.json and data/ hold each person's settings and are never touched.
const HOME_SKILLS = {
  deliver: ['SKILL.md', 'references/parallel.md'],
  'project-memory': ['SKILL.md', 'project-memory.mjs', 'config.example.json'],
  'session-handoff': ['SKILL.md', 'config.example.json'],
  doc: ['SKILL.md', 'doc.mjs'],
  'issue-board': ['SKILL.md', 'board.mjs', 'render.py', 'config.example.json'],
};
const DESIGN_SKILLS = ['ui-design', 'ui-motion', 'native-ui', 'ui-mockup'];

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

// POSIX separators: the path is spliced into JSON hook templates and sh commands.
const uiDesignBin = () => path.join(paths.home(), '.agents', 'skills', 'ui-design', 'scripts', 'ui-design').replaceAll('\\', '/');

/** One argument for the shell that runs hook commands (sh; cmd.exe on Windows). */
function shellQuote(value, platform = process.platform) {
  if (platform === 'win32') return `"${String(value).replace(/"/g, '')}"`;
  return `"${String(value).replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** Hook command with the node binary captured at install, so hooks never depend on PATH. */
function hookCommand(execPath, script, args = '') {
  return `${shellQuote(execPath)} ${shellQuote(path.join(paths.exoDir(), 'hooks', script))}${args ? ` ${args}` : ''}`;
}

// A redirected home (tests, sandboxes) must never reach the real one through external installers or CLIs.
function isolatedHome() {
  if (!process.env.EXONOUS_HOME) return false;
  try {
    return fs.realpathSync(process.env.EXONOUS_HOME) !== fs.realpathSync(os.homedir());
  } catch {
    return true;
  }
}

const devCheckout = (root = PACKAGE_ROOT) => fs.existsSync(path.join(root, '.git'));

/**
 * Prints the target home; a dev checkout refuses to write the real home unless --real-home was given.
 * @param {{ action: string, dryRun?: boolean, realHome?: boolean, log?: (msg: string) => void }} options
 */
function guardTarget({ action, dryRun = false, realHome = false, log = () => {} }) {
  log(`target home: ${paths.home()}${isolatedHome() ? ' (EXONOUS_HOME)' : ''}`);
  if (dryRun || realHome || isolatedHome() || !devCheckout()) return;
  throw new Error(`refusing to ${action} the real home ${paths.home()} from a dev checkout (${PACKAGE_ROOT}); set EXONOUS_HOME to a test home, or pass --real-home if you mean it`);
}

/** @returns {{ action: 'install'|'skip', reason: string }} */
function postinstallDecision(env, root = PACKAGE_ROOT) {
  if (env.CI || env.CONTINUOUS_INTEGRATION) return { action: 'skip', reason: 'CI' };
  if (devCheckout(root)) return { action: 'skip', reason: 'dev checkout — run `exonous install` with EXONOUS_HOME set to test' };
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // keep the given path
  }
  const posix = real.split(path.sep).join('/');
  if (env.npm_config_global === 'true' || /\/\.bun\/install\/global\/|\/pnpm\/global\//.test(posix)) return { action: 'install', reason: 'global install' };
  if (posix.includes('/node_modules/')) return { action: 'skip', reason: 'installed inside a project — exonous now installs machine-wide: npm i -g github:zaqueu-1/exonous then exonous install' };
  return { action: 'install', reason: 'standalone' };
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listFiles(full, base);
    return e.isFile() && e.name !== '.DS_Store' ? [path.relative(base, full)] : [];
  });
}

function installRuntime(home) {
  const hooks = path.join(ASSETS, 'machine', 'hooks');
  for (const rel of listFiles(hooks)) home.sync(path.join(hooks, rel), path.join(paths.exoDir(), 'hooks', rel));
  home.sync(path.join(ASSETS, 'machine', 'PR-TEMPLATE.md'), path.join(paths.exoDir(), 'PR-TEMPLATE.md'));
  for (const variant of VARIANTS) {
    home.write(path.join(paths.exoDir(), 'rules', variant === 'full' ? 'nomos.md' : `nomos.${variant}.md`), renderRules(variant));
  }
}

const installInfoPath = () => path.join(paths.exoDir(), 'install.json');

function readInstallInfo() {
  try {
    return JSON.parse(fs.readFileSync(installInfoPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {{ tools: Record<string, { tier: number }>, dryRun?: boolean }} options */
function writeInstallInfo({ tools, dryRun = false }) {
  const previous = readInstallInfo() || {};
  const version = packageVersion();
  const info = {
    version,
    pm: paths.detectPm(process.env, PACKAGE_ROOT),
    packageRoot: PACKAGE_ROOT,
    source: SOURCE,
    tagSha: previous.version === version ? previous.tagSha ?? null : null,
    installedAt: previous.version === version && previous.installedAt ? previous.installedAt : new Date().toISOString(),
    tools: Object.fromEntries(Object.entries(tools).map(([id, t]) => [id, { tier: t.tier, version }])),
  };
  if (dryRun) return info;
  const file = installInfoPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return info;
}

module.exports = {
  PACKAGE_ROOT, ASSETS, SOURCE, OWNED_MARKER, COMMANDS, HOME_SKILLS, DESIGN_SKILLS,
  packageVersion, uiDesignBin, shellQuote, hookCommand, listFiles, installRuntime, readInstallInfo, writeInstallInfo,
  isolatedHome, devCheckout, guardTarget, postinstallDecision,
};
