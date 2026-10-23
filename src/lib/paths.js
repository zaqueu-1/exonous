'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  return process.env.EXONOUS_HOME || os.homedir();
}

function claudeDir() {
  return path.join(home(), '.claude');
}

function cursorDir() {
  return path.join(home(), '.cursor');
}

function exoDir() {
  return path.join(claudeDir(), 'exonous');
}

function stateDir() {
  return path.join(exoDir(), 'state');
}

/** @returns {'npm'|'pnpm'|'bun'} */
function detectPm(env = process.env, packageRoot = path.join(__dirname, '..', '..')) {
  const agent = /^(npm|pnpm|bun)\//.exec(String(env.npm_config_user_agent || ''));
  if (agent) return agent[1];
  let root = packageRoot;
  try {
    root = fs.realpathSync(packageRoot);
  } catch {
    // missing root: match the path as given
  }
  root = root.split(path.sep).join('/');
  if (root.includes('/.bun/')) return 'bun';
  if (root.includes('/pnpm/')) return 'pnpm';
  return 'npm';
}

module.exports = { home, claudeDir, cursorDir, exoDir, stateDir, detectPm };
