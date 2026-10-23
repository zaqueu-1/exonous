'use strict';

const fs = require('fs');
const { writeAtomic } = require('./writers/markers');

const SKELETONS = {
  claude: () => ({}),
  gemini: () => ({}),
  codex: () => ({}),
  cursor: () => ({ version: 1 }),
  windsurf: () => ({}),
  copilot: () => ({ version: 1 }),
};

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function skeleton(format) {
  if (!SKELETONS[format]) throw new Error(`unknown settings format: ${format}`);
  return SKELETONS[format]();
}

/**
 * Reads, mutates a copy and writes atomically; invalid JSON aborts the file untouched.
 * @param {(config: Record<string, unknown>) => string | null} mutate returns a warning to abort.
 * @returns {{ status: 'written'|'unchanged'|'invalid'|'absent' }}
 */
function edit(file, mutate, { fallback, dryRun = false, log = () => {}, label }) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (raw === null && !fallback) return { status: 'absent' };
  const bom = raw !== null && raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  let config;
  try {
    config = raw === null ? fallback() : JSON.parse(raw.slice(bom.length));
  } catch (err) {
    log(`WARN: ${file} is not valid JSON (${err.message}) — ${label} not written; file left untouched`);
    return { status: 'invalid' };
  }
  if (!isObject(config)) {
    log(`WARN: ${file} is not a JSON object — ${label} not written; file left untouched`);
    return { status: 'invalid' };
  }
  const before = raw === null ? null : JSON.stringify(config);
  const problem = mutate(config);
  if (problem) {
    log(`WARN: ${file} ${problem} — ${label} not written; file left untouched`);
    return { status: 'invalid' };
  }
  if (JSON.stringify(config) === before) return { status: 'unchanged' };
  if (dryRun) {
    log(`DRY: would write ${label} → ${file}`);
    return { status: 'written' };
  }
  const backup = `${file}.exonous.bak`;
  if (raw !== null && !fs.existsSync(backup)) {
    const mode = fs.statSync(file).mode & 0o7777;
    fs.writeFileSync(backup, raw, { encoding: 'utf8', flag: 'wx', mode });
    fs.chmodSync(backup, mode);
  }
  writeAtomic(file, `${bom}${JSON.stringify(config, null, 2)}\n`);
  return { status: 'written' };
}

// JSON escapes a Windows backslash as two characters; both become one forward slash.
const slashes = (text) => text.replace(/\\\\|\\/g, '/');

function stripHooks(config, ownedMarker) {
  if (config.hooks === undefined) return null;
  const marker = slashes(ownedMarker);
  if (!isObject(config.hooks)) return 'has a "hooks" value that is not an object';
  let emptied = false;
  for (const [event, list] of Object.entries(config.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => !slashes(JSON.stringify(entry)).includes(marker));
    if (kept.length === list.length) continue;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
    emptied = true;
  }
  if (emptied && !Object.keys(config.hooks).length) delete config.hooks;
  return null;
}

/**
 * Replaces every hook entry whose JSON contains ownedMarker with `entries`; foreign entries keep their order.
 * @param {{ format: keyof SKELETONS, entries: Record<string, unknown[]>, ownedMarker: string, dryRun?: boolean, log?: (msg: string) => void }} options
 */
function mergeOwned(file, { format, entries, ownedMarker, dryRun, log }) {
  skeleton(format);
  return edit(file, (config) => {
    const problem = stripHooks(config, ownedMarker);
    if (problem) return problem;
    config.hooks = config.hooks || {};
    for (const [event, list] of Object.entries(entries)) {
      const current = config.hooks[event] === undefined ? [] : config.hooks[event];
      if (!Array.isArray(current)) return `has a hooks.${event} value that is not a list`;
      config.hooks[event] = [...current, ...list];
    }
    return null;
  }, { fallback: () => skeleton(format), dryRun, log, label: 'exonous hooks' });
}

/** @param {{ format: keyof SKELETONS, ownedMarker: string, dryRun?: boolean, log?: (msg: string) => void }} options */
function stripOwned(file, { format, ownedMarker, dryRun, log }) {
  skeleton(format);
  return edit(file, (config) => stripHooks(config, ownedMarker), { dryRun, log, label: 'exonous hooks' });
}

/**
 * Sets or (with null) deletes entries of a map such as `mcpServers` or `mcp`, owned by key.
 * @param {{ key: string, entries: Record<string, unknown>, dryRun?: boolean, log?: (msg: string) => void }} options
 */
function mergeKey(file, { key, entries, dryRun, log }) {
  const adds = Object.values(entries).some((v) => v !== null);
  return edit(file, (config) => {
    if (config[key] === undefined && !adds) return null;
    if (config[key] === undefined) config[key] = {};
    if (!isObject(config[key])) return `has a "${key}" value that is not an object`;
    for (const [name, value] of Object.entries(entries)) {
      if (value === null) delete config[key][name];
      else config[key][name] = value;
    }
    return null;
  }, { fallback: adds ? () => ({}) : null, dryRun, log, label: `exonous ${key} entries` });
}

/**
 * Claude `permissions.allow`: drops entries starting with ownedPrefix, then appends `add`; other entries keep their order.
 * @param {{ add: string[], ownedPrefix: string, dryRun?: boolean, log?: (msg: string) => void }} options
 */
function mergeAllow(file, { add, ownedPrefix, dryRun, log }) {
  return edit(file, (config) => {
    if (config.permissions === undefined && !add.length) return null;
    if (config.permissions === undefined) config.permissions = {};
    if (!isObject(config.permissions)) return 'has a "permissions" value that is not an object';
    const current = config.permissions.allow === undefined ? [] : config.permissions.allow;
    if (!Array.isArray(current)) return 'has a "permissions.allow" value that is not a list';
    const kept = current.filter((item) => !(typeof item === 'string' && item.startsWith(ownedPrefix)));
    config.permissions.allow = [...kept, ...add.filter((item) => !kept.includes(item))];
    return null;
  }, { fallback: add.length ? () => ({}) : null, dryRun, log, label: 'exonous permissions' });
}

module.exports = { mergeOwned, stripOwned, mergeKey, mergeAllow, FORMATS: Object.keys(SKELETONS) };
