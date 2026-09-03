#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const git = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });

if (git.status !== 0) {
  process.stderr.write(git.stderr || 'Failed to list tracked files\n');
  process.exit(git.status || 1);
}

const trackedFiles = git.stdout.split(/\r?\n/).filter(Boolean);

// Source/config file types that can embed static secret strings
const scannedExtensions = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx',
  '.json',
  '.yml', '.yaml',
  '.sh',
  '.env',
]);

// Dotenv-style files without a conventional extension.
// .env.example is intentionally excluded — it is a documentation template that
// must contain placeholder text and is never deployed with real secrets.
const scannedBasenames = new Set(['.env', '.env.test', '.env.ci']);

// Files that intentionally contain placeholder patterns for documentation or
// self-testing — exempt from the check.
const safeFixtureFiles = new Set([
  'scripts/check-secret-placeholders.js',
  'scripts/check-secret-placeholders.fixtures.js',
]);

const findings = [];

// Patterns covering all common assignment forms:
//   1. Quoted (single or double):  ENCRYPTION_SECRET: "static-value-32+"
//   2. Template literal (backtick): ENCRYPTION_SECRET=`static-value-32+`
//   3. YAML bare value:             ENCRYPTION_SECRET: static-value-32+
//   4. Dotenv bare value (line-start): ENCRYPTION_SECRET=static-value-32+
//      (distinct from YAML: must start at column 0 or after "export ")
const secretAssignmentPatterns = [
  // Quoted: single or double quotes, no variable interpolation indicators ($, `)
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*[:=]\s*['"]([^'"$`]{32,})['"]/g,

  // Template literal: backtick delimited, no interpolation (${...} excluded)
  // eslint-disable-next-line no-template-curly-in-string
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*[:=]\s*`([^`$]{32,})`/g,

  // YAML/inline bare value after a colon (not a dotenv KEY=VALUE at line start)
  // Excludes function-call syntax so randomTestSecret('label') stays allowed.
  /\b(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\b\s*:\s+([A-Za-z0-9_./+=:@-]{32,})/g,

  // Dotenv bare value: KEY=value at line start (with optional leading "export ")
  /^(?:export\s+)?(?:ENCRYPTION_SECRET|TOKEN_HMAC_SECRET)\s*=\s*([A-Za-z0-9_./+=:@-]{32,})\s*$/gm,
];

for (const relativePath of trackedFiles) {
  if (safeFixtureFiles.has(relativePath)) continue;
  if (relativePath.includes('package-lock.json')) continue;

  const ext = path.extname(relativePath);
  const base = path.basename(relativePath);
  if (!scannedExtensions.has(ext) && !scannedBasenames.has(base)) continue;

  const absolutePath = path.join(repoRoot, relativePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const pattern of secretAssignmentPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        findings.push({
          file: relativePath,
          line: index + 1,
          variable: match[0].split(/\s*[:=]\s*/)[0].replace(/^export\s+/, '').trim(),
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(
    'Secret placeholder guard failed. Do not commit static 32+ character ' +
    'ENCRYPTION_SECRET or TOKEN_HMAC_SECRET values in code, tests, or CI. ' +
    'Generate them at runtime instead.',
  );
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.variable})`);
  }
  process.exit(1);
}

console.log('Secret placeholder guard passed.');
