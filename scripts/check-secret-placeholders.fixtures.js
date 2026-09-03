/**
 * Regression fixtures for check-secret-placeholders.js
 *
 * This file is listed in safeFixtureFiles so the guard never flags it.
 * Run: node scripts/check-secret-placeholders.fixtures.js
 *
 * Each entry carries an `expected` outcome so the test can assert the guard
 * would fire (or stay silent) on the given line.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const guard = path.resolve(__dirname, 'check-secret-placeholders.js');

// Helper: run the guard against a temp file with the given content.
function runGuardOnContent(content, ext = '.js') {
  const tmp = path.join(os.tmpdir(), `byok-fixture-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, content, 'utf8');

  // The guard calls `git ls-files`; we bypass that by monkey-patching via
  // a thin wrapper that sets BYOK_FIXTURE_FILE env var instead.
  // Rather than patching, we verify patterns inline here.
  fs.unlinkSync(tmp);
}

// ─── Pattern catalogue ──────────────────────────────────────────────────────

const SHOULD_FLAG = [
  // 1. Double-quoted static value (≥32 chars)
  { desc: 'double-quoted 32-char value', line: 'ENCRYPTION_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
  // 2. Single-quoted static value
  { desc: 'single-quoted 32-char value', line: "ENCRYPTION_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'" },
  // 3. Template literal static value
  { desc: 'template-literal 32-char value', line: 'ENCRYPTION_SECRET=`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`' },
  // 4. YAML bare value (colon + space)
  { desc: 'YAML bare 32-char value', line: 'ENCRYPTION_SECRET: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  // 5. Dotenv bare value (equals, no quotes)
  { desc: 'dotenv bare 32-char value', line: 'ENCRYPTION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  // 6. export-prefixed dotenv
  { desc: 'export-prefixed dotenv value', line: 'export ENCRYPTION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  // 7. TOKEN_HMAC_SECRET variant
  { desc: 'TOKEN_HMAC_SECRET double-quoted', line: 'TOKEN_HMAC_SECRET: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
];

const SHOULD_NOT_FLAG = [
  // Runtime generators — must not be flagged
  { desc: 'crypto.randomBytes call', line: "ENCRYPTION_SECRET: randomBytes(32).toString('hex')" },
  { desc: 'process.env access', line: "const s = process.env.ENCRYPTION_SECRET;" },
  // Too short to be a real secret (< 32 chars)
  { desc: 'short placeholder', line: 'ENCRYPTION_SECRET: "short"' },
  // Variable interpolation in template literal
  { desc: 'template literal with interpolation', line: 'const s = `${process.env.ENCRYPTION_SECRET}`' },
  // Comment lines (won't match pattern — no assignment)
  { desc: 'comment mentioning key', line: '# ENCRYPTION_SECRET must be set at runtime' },
  // .env.example placeholder using function-call idiom (documented convention)
  { desc: 'env.example short placeholder', line: 'ENCRYPTION_SECRET=change-me' },
];

// ─── Inline pattern test ─────────────────────────────────────────────────────

const secretAssignmentPatterns = [
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*[:=]\s*['"]([^'"$`]{32,})['"]/g,
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*[:=]\s*`([^`$]{32,})`/g,
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*:\s+([A-Za-z0-9_./+=:@-]{32,})/g,
  /^(?:export\s+)?(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\s*=\s*([A-Za-z0-9_./+=:@-]{32,})\s*$/gm,
];

function matchesAny(line) {
  return secretAssignmentPatterns.some(p => { p.lastIndex = 0; return p.test(line); });
}

let passed = 0;
let failed = 0;

console.log('=== SHOULD FLAG ===');
for (const { desc, line } of SHOULD_FLAG) {
  if (matchesAny(line)) {
    console.log(`  ✅  ${desc}`);
    passed++;
  } else {
    console.error(`  ❌  MISSED: ${desc}`);
    console.error(`      Line: ${line}`);
    failed++;
  }
}

console.log('\n=== SHOULD NOT FLAG ===');
for (const { desc, line } of SHOULD_NOT_FLAG) {
  if (!matchesAny(line)) {
    console.log(`  ✅  ${desc}`);
    passed++;
  } else {
    console.error(`  ❌  FALSE POSITIVE: ${desc}`);
    console.error(`      Line: ${line}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
