'use strict';

// exonous doctor: one screen, every piece, and the fix for whatever is missing.
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const { select, selftest } = require('./adapters');
const { DESIGN_SKILLS, packageVersion, readInstallInfo } = require('./lib/runtime');
const { LEFTOVERS } = require('./legacy/bridge');

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
  const checks = [...sharedChecks(), ...tools.flatMap((a) => a.doctor({})), ...gates];
  console.log(`exonous v${packageVersion()} — ${tools.map((a) => a.id).join(', ') || 'no supported tool detected'}\n`);
  for (const check of checks) {
    const detail = check.status ? ` (${check.status})` : '';
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}${detail}${check.ok ? '' : `\n      fix: ${check.fix}`}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} problem(s).` : '\nAll good.');
  return failed ? 1 : 0;
}

module.exports = { doctor };
