'use strict';

// exonous doctor: one screen, every piece, and the fix for whatever is missing.
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const { select, selftest } = require('./adapters');
const { DESIGN_SKILLS, packageVersion, readInstallInfo } = require('./lib/runtime');
const { LEFTOVERS } = require('./legacy/bridge');
const selfupdate = require('../assets/machine/hooks/lib/selfupdate.cjs');

const FIX = 'exonous install';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function hasMcp(key) {
  return [path.join(paths.claudeDir(), '.mcp.json'), path.join(paths.home(), '.claude.json')]
    .some((file) => Boolean(readJson(file)?.mcpServers?.[key]));
}

function updateChecks() {
  const moved = selfupdate.tagWarning();
  const last = selfupdate.lastCheck();
  const off = selfupdate.optedOut();
  const age = last === null ? 'never checked' : `last check ${Math.round((Date.now() - last) / 3600000)} h ago`;
  return [
    { name: 'self-update', ok: true, status: off ? `off (${off})` : age, fix: 'exonous update' },
    {
      name: 'release tag unchanged since install',
      ok: !moved,
      status: moved ? `v${moved.version} now points to ${moved.actual.slice(0, 12)}, installed from ${moved.expected.slice(0, 12)}` : '',
      fix: 'check the tag on github.com/zaqueu-1/exonous before trusting it, then exonous update',
    },
  ];
}

function sharedChecks() {
  const info = readInstallInfo();
  const memoryConfig = readJson(path.join(paths.claudeDir(), 'skills', 'project-memory', 'config.json'));
  const leftovers = LEFTOVERS.filter((rel) => fs.existsSync(path.join(paths.home(), rel)));
  return [
    { name: 'machine install (install.json)', ok: Boolean(info), status: info ? `v${info.version} via ${info.pm}` : '', fix: FIX },
    { name: 'gate runtime (~/.claude/exonous/hooks)', ok: fs.existsSync(path.join(paths.exoDir(), 'hooks', 'pyle.cjs')), fix: FIX },
    { name: 'design stack', ok: DESIGN_SKILLS.every((s) => fs.existsSync(path.join(paths.home(), '.agents', 'skills', s, 'SKILL.md'))), fix: FIX },
    { name: 'atlas MCP (code graph)', ok: hasMcp('atlas'), fix: 'exonous install (or node <exonous>/src/lib/atlas.js --force)' },
    { name: 'biblos MCP (library docs)', ok: hasMcp('biblos'), fix: 'exonous install' },
    {
      name: 'project-memory vault',
      ok: Boolean(process.env.PROJECT_MEMORY_VAULT || (memoryConfig?.vault && fs.existsSync(memoryConfig.vault))),
      fix: 'create ~/.claude/skills/project-memory/config.json with { "vault": "<abs path>" }',
    },
    { name: 'no leftovers from older installs', ok: !leftovers.length, status: leftovers.map((r) => `~/${r}`).join(', '), fix: FIX },
  ];
}

function doctor() {
  const tools = select({}).selected;
  const gates = tools.map((a) => {
    const result = selftest(a);
    return { name: `${a.id}: gate self-test`, ok: result.ok, status: result.detail, fix: 'exonous install' };
  });
  const checks = [...sharedChecks(), ...updateChecks(), ...tools.flatMap((a) => a.doctor({})), ...gates];
  console.log(`exonous v${packageVersion()} — ${tools.map((a) => a.id).join(', ') || 'no supported tool detected'}\n`);
  const { text, failed } = report(checks);
  console.log(text);
  return failed ? 1 : 0;
}

/** Rows exonous cannot verify carry level 'warn': shown with ⚠ and their fix, never counted as failures. */
function report(checks) {
  const lines = checks.map((check) => {
    const warn = !check.ok && check.level === 'warn';
    const mark = check.ok ? '✓' : warn ? '⚠' : '✗';
    const detail = check.status ? ` (${check.status})` : '';
    return `  ${mark} ${check.name}${detail}${check.ok ? '' : `\n      fix: ${check.fix}`}`;
  });
  const failed = checks.filter((c) => !c.ok && c.level !== 'warn').length;
  const warned = checks.filter((c) => !c.ok && c.level === 'warn').length;
  const tail = warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : '';
  lines.push(failed ? `\n${failed} problem(s)${tail}.` : `\nAll good${tail}.`);
  return { text: lines.join('\n'), failed, warned };
}

module.exports = { doctor, report };
