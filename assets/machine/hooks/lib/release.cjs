'use strict';

// Self-contained: copied to ~/.claude/exonous/hooks/lib/, node builtins only.
const { execFileSync } = require('child_process');

const RELEASE_REF = /^v(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * @param {string} url
 * @param {{ major?: number }} [options]
 * @returns {{ version: string, sha: string } | null}
 */
function latestRelease(url, { major } = {}) {
  const source = process.env.EXONOUS_RELEASE_SOURCE || url;
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', '--', source, 'v*'], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const releases = out.split('\n')
    .map((line) => {
      const [sha, ref = ''] = line.split('\t');
      const m = RELEASE_REF.exec(ref.replace(/^refs\/tags\//, ''));
      return m ? { sha, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter((r) => r && (major === undefined || r.parts[0] === major))
    .sort((a, b) => compareVersions(a.parts, b.parts));
  const top = releases[releases.length - 1];
  return top ? { version: top.parts.join('.'), sha: top.sha } : null;
}

module.exports = { RELEASE_REF, compareVersions, latestRelease };
