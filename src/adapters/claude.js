'use strict';

// Claude Code: rules, commands, skills, stack rules, agents, techne plugin, and the gate hooks in ~/.claude/settings.json.
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const { onPath } = require('./shared');
const { mergeOwned, stripOwned, mergeAllow } = require('../lib/settings');
const { installTechne, PLUGIN_ID } = require('../lib/techne');
const { installAgents } = require('../lib/agents');
const { ASSETS, OWNED_MARKER, COMMANDS, HOME_SKILLS, DESIGN_SKILLS, hookCommand, listFiles } = require('../lib/runtime');

const TOOL = 'claude';
const ALLOW_PREFIX = 'Bash(exonous ';
// Token minting stays behind the human prompt; only read-only exonous commands are pre-approved.
const EXONOUS_ALLOW = ['workflow*', 'template*', 'draft-path*', 'validate-pr*'].map((c) => `${ALLOW_PREFIX}${c})`);

const settingsFile = () => path.join(paths.claudeDir(), 'settings.json');

function detect() {
  return fs.existsSync(paths.claudeDir()) || onPath('claude');
}

function hookEntries(execPath) {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand(execPath, 'pyle.cjs', 'auto --adapter claude') }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: hookCommand(execPath, 'lib/metron.cjs') }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand(execPath, 'kairos.cjs', '--adapter claude') }] }],
  };
}

function installSkills(home, log) {
  const opts = { tool: TOOL };
  for (const [name, files] of Object.entries(HOME_SKILLS)) {
    const dir = path.join(paths.claudeDir(), 'skills', name);
    const existing = path.join(dir, 'SKILL.md');
    if (fs.existsSync(existing) && !new RegExp(`^name: ${name}\\r?$`, 'm').test(fs.readFileSync(existing, 'utf8'))) {
      log(`WARN: ~/.claude/skills/${name}/ holds a different skill — left untouched`);
      continue;
    }
    for (const file of files) home.sync(path.join(ASSETS, 'skills', name, file), path.join(dir, file), opts);
  }
}

function installDesignLinks(home, dryRun) {
  for (const name of DESIGN_SKILLS) home.link(path.join(paths.home(), '.agents', 'skills', name), path.join(paths.claudeDir(), 'skills', name));
  const patterns = path.join(paths.claudeDir(), 'skills', 'ui-patterns');
  if (!dryRun) fs.rmSync(patterns, { recursive: true, force: true });
  home.copyTree(path.join(ASSETS, 'skills', 'ui-patterns'), patterns);
}

/** @param {{ home: object, dryRun: boolean, log: (m: string) => void, execPath: string, permissions?: boolean, external: boolean, detected: Record<string, boolean> }} ctx */
function install(ctx) {
  const { home, dryRun, log } = ctx;
  const opts = { tool: TOOL };
  home.sync(path.join(ASSETS, 'rules', 'nomos.md'), path.join(paths.claudeDir(), 'rules', 'nomos.md'), opts);
  for (const name of COMMANDS) home.sync(path.join(ASSETS, 'skills', name, 'SKILL.md'), path.join(paths.claudeDir(), 'commands', `${name}.md`), opts);
  installSkills(home, log);
  const stack = path.join(ASSETS, 'techne', 'rules');
  for (const rel of listFiles(stack)) home.sync(path.join(stack, rel), path.join(paths.claudeDir(), 'rules', 'exonous', rel), opts);
  installDesignLinks(home, dryRun);
  if (ctx.external) installTechne({ dryRun, log });
  else log('techne plugin skipped: EXONOUS_HOME is not the real home, so the claude CLI is not called');
  installAgents({ dryRun, log, hasCursor: Boolean(ctx.detected.cursor), execPath: ctx.execPath });
  mergeOwned(settingsFile(), { format: 'claude', entries: hookEntries(ctx.execPath), ownedMarker: OWNED_MARKER, dryRun, log });
  if (ctx.permissions) mergeAllow(settingsFile(), { add: EXONOUS_ALLOW, ownedPrefix: ALLOW_PREFIX, dryRun, log });
}

function uninstall({ dryRun, log }) {
  stripOwned(settingsFile(), { format: 'claude', ownedMarker: OWNED_MARKER, dryRun, log });
  mergeAllow(settingsFile(), { add: [], ownedPrefix: ALLOW_PREFIX, dryRun, log });
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** The gate command this tool would run, as registered in its config. */
function registeredCommand() {
  const entry = ((readSettings().hooks || {}).PreToolUse || []).find((e) => e && e.matcher === 'Bash' && JSON.stringify(e).includes('pyle.cjs'));
  return entry && entry.hooks && entry.hooks[0] ? entry.hooks[0].command : null;
}

const selftestPayload = (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

const row = (name, ok, fix = 'exonous install', status = '') => ({ name: `Claude Code: ${name}`, ok, status, fix });

function doctor() {
  const settings = readSettings();
  const hooks = JSON.stringify(settings.hooks || {});
  const agents = fs.existsSync(path.join(paths.claudeDir(), 'agents'))
    ? fs.readdirSync(path.join(paths.claudeDir(), 'agents')).filter((f) => /^exo-.+\.md$/.test(f)).length
    : 0;
  return [
    row('gate hook (commit, push, pr)', hooks.includes('pyle.cjs') && hooks.includes('auto --adapter claude') && fs.existsSync(path.join(paths.exoDir(), 'hooks', 'pyle.cjs'))),
    row('self-update hook (kairos)', hooks.includes('kairos.cjs') && hooks.includes('--adapter claude')),
    row('nomos rule', fs.existsSync(path.join(paths.claudeDir(), 'rules', 'nomos.md'))),
    row('commands', COMMANDS.every((c) => fs.existsSync(path.join(paths.claudeDir(), 'commands', `${c}.md`)))),
    row('skills', Object.keys(HOME_SKILLS).every((s) => fs.existsSync(path.join(paths.claudeDir(), 'skills', s, 'SKILL.md')))),
    row('agents exo-* + taxis', agents === 12 && hooks.includes('taxis.js'), 'exonous install', `${agents}/12 agents`),
    row('techne plugin', fs.existsSync(path.join(paths.claudeDir(), 'techne')) && settings.enabledPlugins?.[PLUGIN_ID] !== false),
  ];
}

module.exports = { id: TOOL, tier: 1, gate: 'hard', detect, install, uninstall, doctor, registeredCommand, selftestPayload };
