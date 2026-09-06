#!/usr/bin/env node
/**
 * verify-attestation.js
 *
 * Verifies that the files in the current working directory match the SHA-256
 * hashes recorded in a byok-relay attestation.json.
 *
 * Usage:
 *   node scripts/verify-attestation.js [path/to/attestation.json]
 *
 * Typical workflow:
 *   1. Hit GET /version on a byok-relay instance:
 *        curl https://relay.byokrelay.com/version
 *      Note the { version, commit } values.
 *
 *   2. Download the attestation manifest for that release:
 *        curl -L https://github.com/avikalpg/byok-relay/releases/download/v<version>/attestation.json \
 *             -o attestation.json
 *
 *   3. Clone the repo at the reported commit:
 *        git clone https://github.com/avikalpg/byok-relay byok-relay-verify
 *        cd byok-relay-verify
 *        git checkout <commit>
 *
 *   4. Run this script:
 *        node scripts/verify-attestation.js ../attestation.json
 *
 *   Expected output: all PASS lines, exit code 0.
 *   Any FAIL means the running code does not match the published release.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const attestationPath = process.argv[2] || path.join(__dirname, '..', 'attestation.json');

if (!fs.existsSync(attestationPath)) {
  console.error(`Error: attestation file not found: ${attestationPath}`);
  console.error('Usage: node scripts/verify-attestation.js [path/to/attestation.json]');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
} catch (err) {
  console.error(`Error: could not parse attestation file: ${err.message}`);
  process.exit(2);
}

if (manifest.schema !== 'byok-relay-attestation/v1') {
  console.error(`Error: unrecognised schema "${manifest.schema}" — expected "byok-relay-attestation/v1"`);
  process.exit(2);
}

console.log(`\nbyok-relay Attestation Verifier`);
console.log(`================================`);
console.log(`Version  : ${manifest.version}`);
console.log(`Commit   : ${manifest.commit}`);
console.log(`Built at : ${manifest.buildTime}`);
console.log(`Repo     : ${manifest.repoUrl}`);
console.log();

const repoRoot = path.resolve(__dirname, '..');
let allPassed = true;

for (const [filePath, expectedHash] of Object.entries(manifest.attestedFiles)) {
  const fullPath = path.join(repoRoot, filePath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  MISSING  ${filePath}`);
    allPassed = false;
    continue;
  }
  const content = fs.readFileSync(fullPath);
  const actualHash = crypto.createHash('sha256').update(content).digest('hex');
  const ok = actualHash === expectedHash;
  if (!ok) allPassed = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}     ${filePath}`);
  if (!ok) {
    console.log(`           expected: ${expectedHash}`);
    console.log(`           actual  : ${actualHash}`);
  }
}

console.log();
if (allPassed) {
  console.log('All files match the published attestation. ✅');
  console.log('The code running at the relay is the public repo code.');
} else {
  console.log('One or more files do NOT match the published attestation. ❌');
  console.log('The running code may differ from the public release.');
  process.exit(1);
}
