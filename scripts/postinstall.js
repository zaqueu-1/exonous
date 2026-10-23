#!/usr/bin/env node
// Bridge shim: tron-era session hooks call this path after updating. Removed together with src/legacy/.
const { postinstallDecision } = require('../src/lib/runtime');

const decision = postinstallDecision(process.env);
if (decision.action === 'skip') console.log(`[exonous] postinstall skipped: ${decision.reason}`);
else require('../src/install').install({ quiet: true });
