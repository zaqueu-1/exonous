'use strict';

// Helpers every tool adapter shares: detection on PATH, Claude's MCP registrations, and owned MCP entries.
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const { mergeKey } = require('../lib/settings');

const MCP_KEYS = ['atlas', 'biblos'];
const SECRETISH = /key|token|secret|password|auth/i;

const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * atlas/biblos as registered for Claude Code, reduced to what other tools need. Headers and env are never copied.
 * @returns {Record<string, { command: string, args: string[] } | { url: string }>}
 */
function claudeMcp({ log = () => {} } = {}) {
  const files = [path.join(paths.claudeDir(), '.mcp.json'), path.join(paths.home(), '.claude.json')];
  const out = {};
  for (const key of MCP_KEYS) {
    const entry = files.map((f) => readJson(f)?.mcpServers?.[key]).find(Boolean);
    if (!entry) continue;
    if (typeof entry.command === 'string') {
      const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
      // A credential passed as an argument would be copied into every tool's config.
      if (args.some((a) => SECRETISH.test(a))) {
        log(`${key} MCP not copied to other tools: its arguments look like they carry a credential — register it there by hand`);
        continue;
      }
      out[key] = { command: entry.command, args };
    } else if (typeof entry.url === 'string' && /^https:\/\//.test(entry.url)) {
      if (SECRETISH.test(entry.url.replace(/^[^?#]*/, ''))) {
        log(`${key} MCP not copied to other tools: its URL query looks like it carries a credential — register it there by hand`);
        continue;
      }
      out[key] = { url: entry.url };
    }
  }
  return out;
}

const ownedFile = () => path.join(paths.stateDir(), 'mcp-owned.json');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * MCP entries in a JSON map (`mcpServers`, `mcp`), ours only while unchanged since exonous wrote them; a user's own entry is never touched.
 * @param {{ tool: string, key: string, entries: Record<string, unknown>, dryRun?: boolean, log?: (m: string) => void, jsonc?: boolean }} options
 */
function mergeMcp(file, { tool, key, entries, dryRun = false, log = () => {}, jsonc = false }) {
  const owned = readJson(ownedFile()) || {};
  const mine = owned[tool] || {};
  const current = readJson(file)?.[key] || {};
  const changes = {};
  const next = {};
  for (const name of new Set([...Object.keys(entries), ...Object.keys(mine)])) {
    const theirs = name in current && !(name in mine && same(current[name], mine[name]));
    if (theirs) {
      if (name in entries) log(`${file} already has its own ${key}.${name} — left as is`);
      continue;
    }
    if (name in entries) {
      changes[name] = entries[name];
      next[name] = entries[name];
    } else if (name in current) {
      changes[name] = null;
    }
  }
  if (!Object.keys(changes).length) return { status: 'unchanged' };
  const res = mergeKey(file, { key, entries: changes, dryRun, log, jsonc });
  if (res.status !== 'invalid' && !dryRun) {
    owned[tool] = next;
    fs.mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownedFile(), `${JSON.stringify(owned, null, 2)}\n`, { mode: 0o600 });
  }
  return res;
}

/** Removes only the MCP entries exonous wrote for this tool, unchanged since. */
const removeMcp = (file, options) => mergeMcp(file, { ...options, entries: {} });

/** Doctor row every soft-tier tool shows: rules may load, nothing blocks a commit. */
const softRow = (label, what = 'rules only') => ({
  name: `${label}: gate`, ok: false, level: 'warn', status: `soft: not enforced — ${what}`,
  fix: 'commit through a hard-gated tool, or run `exonous workflow commit` and review by hand',
});

module.exports = { onPath, readJson, claudeMcp, mergeMcp, removeMcp, softRow, MCP_KEYS };
