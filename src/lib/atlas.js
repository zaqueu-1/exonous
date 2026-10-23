#!/usr/bin/env node
'use strict';

/**
 * Ensure atlas (structural code graph MCP) is installed and registered as `atlas`
 * for Claude Code and Cursor. The engine binary is fetched by its platform installer; exonous owns
 * the registration name so agents, rules and skills only ever reference `atlas`.
 *
 * macOS/Linux: install.sh | Windows: install.ps1 (Unblock-File) | Fallback: npm global
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const SERVER_KEY = 'atlas';
const ENGINE = 'codebase-memory-mcp';
const ENGINE_INSTALL_SH = `https://raw.githubusercontent.com/DeusData/${ENGINE}/main/install.sh`;
const ENGINE_INSTALL_PS1 = `https://raw.githubusercontent.com/DeusData/${ENGINE}/main/install.ps1`;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 120000;

function log(msg) {
  process.stdout.write(`[exonous] ${msg}\n`);
}

function mcpConfigPaths() {
  const home = os.homedir();
  return [
    { file: path.join(home, '.claude', '.mcp.json'), required: true },
    { file: path.join(home, '.claude.json'), required: false },
    { file: path.join(home, '.cursor', 'mcp.json'), required: true, onlyIfDir: path.join(home, '.cursor') },
  ];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.exonous-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isRegisteredInMcpJson() {
  const config = readJson(mcpConfigPaths()[0].file);
  return Boolean(config?.mcpServers?.[SERVER_KEY]);
}

function binaryCandidates() {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? `${ENGINE}.exe` : ENGINE;
  return [
    path.join(home, '.local', 'bin', exe),
    path.join(home, 'bin', exe),
    path.join(home, `.${ENGINE}`, exe),
    path.join(home, 'AppData', 'Local', ENGINE, exe),
  ];
}

function findBinary() {
  const onDisk = binaryCandidates().find((candidate) => fs.existsSync(candidate));
  if (onDisk) return onDisk;
  try {
    const cmd = process.platform === 'win32' ? `where ${ENGINE}` : `command -v ${ENGINE}`;
    return execSync(cmd, { encoding: 'utf8', shell: true, timeout: 5000 }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function isBinaryOnPath() {
  return Boolean(findBinary());
}

function isEngineEntry(name, entry) {
  return name === SERVER_KEY || name.includes('codebase-memory') || String(entry?.command || '').includes(ENGINE);
}

/** Register the engine under `atlas` and drop the engine's own key in every MCP config. */
function normalizeRegistration(binary, { dryRun = false } = {}) {
  const changed = [];
  for (const { file, required, onlyIfDir } of mcpConfigPaths()) {
    if (onlyIfDir && !fs.existsSync(onlyIfDir)) continue;
    const exists = fs.existsSync(file);
    if (!exists && !required) continue;
    const config = (exists ? readJson(file) : {}) || null;
    if (!config) {
      log(`WARN: ${file} is not valid JSON — skipped ${SERVER_KEY} registration`);
      continue;
    }
    const servers = config.mcpServers || {};
    const legacy = Object.keys(servers).filter((name) => name !== SERVER_KEY && isEngineEntry(name, servers[name]));
    const entry = servers[SERVER_KEY] || (legacy.length ? servers[legacy[0]] : null) || { command: binary };
    const next = Object.fromEntries(Object.entries(servers).filter(([name]) => !legacy.includes(name)));
    next[SERVER_KEY] = entry;
    if (JSON.stringify(next) === JSON.stringify(servers)) continue;

    changed.push(file);
    if (dryRun) continue;
    writeJsonAtomic(file, { ...config, mcpServers: next });
  }
  return changed;
}

function runUnixInstaller() {
  execSync(`curl -fsSL "${ENGINE_INSTALL_SH}" | bash`, {
    stdio: 'ignore',
    shell: true,
    timeout: ATTEMPT_TIMEOUT_MS,
    env: process.env,
  });
}

function runWindowsInstaller() {
  const ps1 = path.join(os.tmpdir(), `atlas-install-${Date.now()}.ps1`);
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `Invoke-WebRequest -Uri '${ENGINE_INSTALL_PS1}' -OutFile '${ps1}'`,
    `Unblock-File -Path '${ps1}'`,
    `& '${ps1}'`,
  ].join('; ');

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'ignore', timeout: ATTEMPT_TIMEOUT_MS, env: process.env }
  );
  if (result.status !== 0) {
    throw new Error(`Windows installer exited with code ${result.status}`);
  }
}

function runNpmFallback() {
  const pmCmds = [`npm install -g ${ENGINE}`, `pnpm add -g ${ENGINE}`, `bun add -g ${ENGINE}`];
  let lastError;
  for (const cmd of pmCmds) {
    try {
      execSync(cmd, { stdio: 'ignore', shell: true, timeout: ATTEMPT_TIMEOUT_MS });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('npm/pnpm/bun global install failed');
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function runPlatformInstaller() {
  if (process.platform === 'win32') {
    runWindowsInstaller();
    return;
  }
  try {
    runUnixInstaller();
  } catch (err) {
    if (!isWsl()) throw err;
    log('atlas: Unix installer failed in WSL — trying npm global fallback…');
    runNpmFallback();
  }
}

function isAtlasReady() {
  return isRegisteredInMcpJson() && isBinaryOnPath();
}

/**
 * Ensure atlas is installed and registered.
 * @param {{ silent?: boolean, force?: boolean, dryRun?: boolean }} [options]
 * @returns {{ ok: boolean, alreadyReady?: boolean, attempts?: number }}
 */
function ensureAtlas(options = {}) {
  const emit = options.silent ? () => {} : log;

  if (!options.force) {
    const binary = findBinary();
    if (binary) {
      const changed = normalizeRegistration(binary, { dryRun: options.dryRun });
      for (const file of changed) emit(`${options.dryRun ? 'DRY: would register' : 'registered'} atlas → ${file}`);
      if (isAtlasReady() || (options.dryRun && changed.length)) return { ok: true, alreadyReady: !changed.length };
    }
  }
  if (options.dryRun) {
    emit('DRY: would install atlas engine and register it');
    return { ok: true };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      emit(`atlas: install attempt ${attempt}/${MAX_ATTEMPTS}…`);
      try {
        runPlatformInstaller();
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && process.platform !== 'win32' && !isWsl()) throw err;
        lastError = err;
        emit('atlas: platform installer failed — trying npm global fallback…');
        runNpmFallback();
      }

      const binary = findBinary();
      if (binary) normalizeRegistration(binary);
      if (isAtlasReady()) {
        emit('atlas installed and registered');
        return { ok: true, attempts: attempt };
      }
      lastError = new Error('installer finished but atlas is still not registered');
    } catch (err) {
      lastError = err;
    }
  }

  emit(`ERROR: atlas install FAILED after ${MAX_ATTEMPTS} attempts`);
  emit(`  macOS/Linux: curl -fsSL ${ENGINE_INSTALL_SH} | bash && npm run ensure:atlas`);
  emit(`  Windows:     irm ${ENGINE_INSTALL_PS1} | iex; npm run ensure:atlas`);
  if (lastError?.message) emit(`  Last error: ${lastError.message}`);
  return { ok: false, attempts: MAX_ATTEMPTS };
}

module.exports = { ensureAtlas };

if (require.main === module) {
  const result = ensureAtlas({ force: process.argv.includes('--force'), dryRun: process.argv.includes('--dry-run') });
  process.exit(result.ok ? 0 : 1);
}
