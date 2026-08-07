/**
 * config.test.js — deployment configuration & documentation tests
 *
 * These tests statically validate the platform config files and docs added
 * in the "Replit support + Railway volume persistence" change:
 *   - .replit
 *   - railway.toml
 *   - replit.nix
 *   - README.md (Railway/Replit deploy sections + badges)
 *   - submissions/railway-template.md
 *
 * The files are plain TOML/Nix/Markdown, so rather than pulling in a TOML/Nix
 * parser dependency, these tests use targeted regexes against the raw file
 * contents to assert on the specific keys/values that matter for deploys
 * (ports, health checks, DB_PATH, Node version) and for cross-file
 * consistency (e.g. the DB_PATH default must match everywhere it's quoted).
 *
 * Run:  node --test test/config.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// --- shared fixtures (read once) -------------------------------------------------

const replitConf = readFile('.replit');
const railwayToml = readFile('railway.toml');
const replitNix = readFile('replit.nix');
const readme = readFile('README.md');
const submissionDoc = readFile('submissions/railway-template.md');

// --- small parsing helpers ---------------------------------------------------------

/** Extracts the value from a `[[deploy.envVars]]` block by its `name`. */
function railwayEnvVarValue(content, name) {
  const re = new RegExp(
    `\\[\\[deploy\\.envVars\\]\\]\\s*\\n\\s*name\\s*=\\s*"${name}"\\s*\\n\\s*value\\s*=\\s*"([^"]*)"`,
  );
  const match = content.match(re);
  return match ? match[1] : null;
}

/** Extracts a bracketed TOML array's raw inner string, e.g. `key = ["a", "b"]`. */
function tomlArray(content, key) {
  const re = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm');
  const match = content.match(re);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
}

/** Extracts a quoted TOML scalar, e.g. `key = "value"`. */
function tomlString(content, key) {
  const re = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm');
  const match = content.match(re);
  return match ? match[1] : null;
}

/**
 * Extracts all `[![alt](imgUrl)](linkUrl)` badge markdown occurrences.
 *
 * Parses per-line rather than with a single greedy/non-greedy regex because
 * some of these link URLs contain literal, unescaped parentheses (e.g. the
 * Railway button's `DB_PATHDesc=...(default: /data/relay.db)` query param),
 * which would otherwise cause a naive `\(([^)]*)\)` match to stop early.
 * Each badge is expected to be a self-contained markdown line, so the link
 * URL is taken as everything between the `)](` separator and the final `)`
 * on the line.
 */
function extractBadges(content) {
  const badges = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('[![') || !line.endsWith(')')) continue;

    const altEnd = line.indexOf('](', 3);
    if (altEnd === -1) continue;
    const alt = line.slice(3, altEnd);

    const imgStart = altEnd + 2;
    const imgLinkSep = line.indexOf(')](', imgStart);
    if (imgLinkSep === -1) continue;
    const imageUrl = line.slice(imgStart, imgLinkSep);

    const linkStart = imgLinkSep + 3;
    const linkUrl = line.slice(linkStart, line.length - 1);

    badges.push({ alt, imageUrl, linkUrl });
  }
  return badges;
}

// --- .replit -------------------------------------------------------------------

describe('.replit configuration', () => {
  it('exists at the repo root', () => {
    assert.equal(fileExists('.replit'), true);
  });

  it('declares the Node 20 module', () => {
    const modules = tomlArray(replitConf, 'modules');
    assert.ok(modules, 'modules array should be present');
    assert.equal(modules.length, 1);
    assert.match(modules[0], /^nodejs-20:/);
  });

  it('runs "npm start" as the top-level run command', () => {
    assert.match(replitConf, /^run\s*=\s*"npm start"$/m);
  });

  it('hides lockfile, node_modules and .config from the file tree', () => {
    const hidden = tomlArray(replitConf, 'hidden');
    assert.ok(hidden);
    assert.deepEqual(hidden.sort(), ['.config', 'node_modules', 'package-lock.json'].sort());
  });

  it('pins the nix channel to stable-23_11', () => {
    const channelMatch = replitConf.match(/\[nix\]\s*\n\s*channel\s*=\s*"([^"]+)"/);
    assert.ok(channelMatch, 'expected a [nix] section with a channel key');
    assert.equal(channelMatch[1], 'stable-23_11');
  });

  it('sets PORT=3000 in the [env] section', () => {
    const envMatch = replitConf.match(/\[env\]\s*\n\s*PORT\s*=\s*"(\d+)"/);
    assert.ok(envMatch, 'expected a [env] section with a PORT key');
    assert.equal(envMatch[1], '3000');
  });

  it('configures the [deployment] section to run npm start on Cloud Run', () => {
    const runArray = tomlArray(replitConf, 'run');
    assert.deepEqual(runArray, ['sh', '-c', 'npm start']);

    const target = tomlString(replitConf, 'deploymentTarget');
    assert.equal(target, 'cloudrun');
  });

  it('exposes a single port mapping matching the env PORT', () => {
    const portsMatch = replitConf.match(
      /\[\[ports\]\]\s*\n\s*localPort\s*=\s*(\d+)\s*\n\s*externalPort\s*=\s*(\d+)/,
    );
    assert.ok(portsMatch, 'expected a [[ports]] block with localPort/externalPort');
    assert.equal(portsMatch[1], '3000');
    assert.equal(portsMatch[2], '80');

    // there should be exactly one [[ports]] table
    const occurrences = (replitConf.match(/\[\[ports\]\]/g) || []).length;
    assert.equal(occurrences, 1);
  });
});

// --- railway.toml ------------------------------------------------------------------

describe('railway.toml configuration', () => {
  it('exists at the repo root', () => {
    assert.equal(fileExists('railway.toml'), true);
  });

  it('builds with NIXPACKS pinned to Node 20', () => {
    assert.match(railwayToml, /\[build\]\s*\n\s*builder\s*=\s*"NIXPACKS"/);
    const versionMatch = railwayToml.match(
      /\[build\.buildArgs\]\s*\n\s*NIXPACKS_NODE_VERSION\s*=\s*"(\d+)"/,
    );
    assert.ok(versionMatch, 'expected [build.buildArgs] with NIXPACKS_NODE_VERSION');
    assert.equal(versionMatch[1], '20');
  });

  it('keeps the existing deploy/healthcheck/restart settings', () => {
    assert.match(railwayToml, /startCommand\s*=\s*"npm start"/);
    assert.match(railwayToml, /healthcheckPath\s*=\s*"\/health"/);
    assert.match(railwayToml, /healthcheckTimeout\s*=\s*30\b/);
    assert.match(railwayToml, /restartPolicyType\s*=\s*"ON_FAILURE"/);
    assert.match(railwayToml, /restartPolicyMaxRetries\s*=\s*5\b/);
  });

  it('sets NODE_ENV and PORT env vars', () => {
    assert.equal(railwayEnvVarValue(railwayToml, 'NODE_ENV'), 'production');
    assert.equal(railwayEnvVarValue(railwayToml, 'PORT'), '3000');
  });

  it('adds a DB_PATH env var pointing at the volume mount path', () => {
    assert.equal(railwayEnvVarValue(railwayToml, 'DB_PATH'), '/data/relay.db');
  });

  it('documents the required volume mount in comments', () => {
    assert.match(railwayToml, /mounted at \/data/);
    assert.match(railwayToml, /Add Volume/);
    assert.match(railwayToml, /ephemeral layer and resets on deploy/);
  });

  it('declares exactly three envVars blocks (NODE_ENV, PORT, DB_PATH)', () => {
    const occurrences = (railwayToml.match(/\[\[deploy\.envVars\]\]/g) || []).length;
    assert.equal(occurrences, 3);
  });
});

// --- replit.nix ----------------------------------------------------------------

describe('replit.nix configuration', () => {
  it('exists at the repo root', () => {
    assert.equal(fileExists('replit.nix'), true);
  });

  it('has balanced braces', () => {
    const opens = (replitNix.match(/\{/g) || []).length;
    const closes = (replitNix.match(/\}/g) || []).length;
    assert.equal(opens, closes);
    assert.ok(opens > 0, 'expected at least one brace pair');
  });

  it('declares Node 20, npm, python3 and native build tools as deps', () => {
    for (const dep of [
      'pkgs.nodejs_20',
      'pkgs.nodePackages.npm',
      'pkgs.python3',
      'pkgs.gcc',
      'pkgs.gnumake',
    ]) {
      assert.ok(replitNix.includes(dep), `expected replit.nix to declare ${dep}`);
    }
  });

  it('sets NODE_ENV=development for the Repl shell', () => {
    assert.match(replitNix, /env\s*=\s*\{\s*\n\s*NODE_ENV\s*=\s*"development";/);
  });

  it('takes a pkgs argument and returns an attrset with deps/env', () => {
    assert.match(replitNix.trim(), /^\{\s*pkgs\s*\}\s*:\s*\{/);
    assert.match(replitNix, /deps\s*=\s*\[/);
  });
});

// --- README.md (Railway + Replit deploy docs) -----------------------------------

describe('README.md deployment badges', () => {
  it('has a "Run on Replit" badge in the top badge row', () => {
    const badges = extractBadges(readme);
    const replitBadges = badges.filter((b) => b.alt === 'Run on Replit');
    assert.ok(replitBadges.length >= 1, 'expected at least one "Run on Replit" badge');
    for (const badge of replitBadges) {
      assert.equal(badge.imageUrl, 'https://replit.com/badge/github/avikalpg/byok-relay');
      assert.equal(badge.linkUrl, 'https://replit.com/github/avikalpg/byok-relay');
    }
  });

  it('repeats the exact same Replit badge markdown in the top row and the Replit section', () => {
    const badgeMarkdown = '[![Run on Replit](https://replit.com/badge/github/avikalpg/byok-relay)](https://replit.com/github/avikalpg/byok-relay)';
    const occurrences = readme.split(badgeMarkdown).length - 1;
    assert.equal(occurrences, 2, 'expected the Replit badge to appear exactly twice');
  });

  it('repeats the exact same Railway deploy button markdown in the top row and the Railway section', () => {
    const badges = extractBadges(readme);
    const railwayBadges = badges.filter((b) => b.alt === 'Deploy on Railway');
    assert.equal(railwayBadges.length, 2, 'expected the Railway button to appear exactly twice');
    assert.equal(railwayBadges[0].linkUrl, railwayBadges[1].linkUrl);
  });

  it('includes DB_PATH in the Railway deploy button env var list with a /data/relay.db default', () => {
    const badges = extractBadges(readme);
    const railwayBadge = badges.find((b) => b.alt === 'Deploy on Railway');
    assert.ok(railwayBadge, 'expected a "Deploy on Railway" badge');

    const url = new URL(railwayBadge.linkUrl);
    const envs = url.searchParams.get('envs');
    assert.ok(envs, 'expected an envs query param');
    assert.deepEqual(
      envs.split(','),
      ['ENCRYPTION_SECRET', 'ALLOWED_ORIGINS', 'APP_SECRET', 'DB_PATH'],
    );

    assert.equal(url.searchParams.get('DB_PATHDefault'), '/data/relay.db');
    assert.match(url.searchParams.get('DB_PATHDesc') || '', /volume mount/i);
  });
});

describe('README.md Railway deploy section', () => {
  it('has a dedicated "Deploy to Railway" section', () => {
    assert.match(readme, /### Deploy to Railway \(recommended — persistent SQLite\)/);
  });

  it('instructs leaving DB_PATH at its default', () => {
    assert.match(readme, /leave `DB_PATH` as `\/data\/relay\.db`/);
  });

  it('instructs adding a volume before registering users or storing keys', () => {
    assert.match(
      readme,
      /before registering users or storing keys\*\*,\s*open \*\*Dashboard → your service → Volumes → Add Volume\*\* and set the mount path to `\/data`/,
    );
  });

  it('tells the user to redeploy and wait for /health before using the relay', () => {
    assert.match(readme, /Redeploy, wait for `\/health` to succeed/);
  });

  it('documents the migration path for relays that predate the volume', () => {
    assert.match(readme, /Already used the relay without a volume\?/);
    assert.match(readme, /SQLite online backup/);
    assert.match(readme, /Keep the existing `ENCRYPTION_SECRET` and `TOKEN_HMAC_SECRET`/);
  });
});

describe('README.md Replit deploy section', () => {
  it('has a dedicated "Run on Replit" section', () => {
    assert.match(readme, /### Run on Replit \(browser-based, zero install\)/);
  });

  it('instructs setting the three relay secrets via the Replit Secrets tab', () => {
    const section = readme.slice(readme.indexOf('### Run on Replit'));
    for (const secret of ['ENCRYPTION_SECRET', 'ALLOWED_ORIGINS', 'APP_SECRET']) {
      assert.ok(section.includes(secret), `expected the Replit section to mention ${secret}`);
    }
    assert.match(section, /Secrets\*\* tab/);
  });

  it('warns that free Repls sleep and recommends Railway/Render for production', () => {
    const section = readme.slice(readme.indexOf('### Run on Replit'));
    assert.match(section, /sleep after ~5 minutes of inactivity/);
    assert.match(section, /use Railway or Render instead/);
  });

  it('is ordered between the Render and Vercel deploy sections', () => {
    const renderIdx = readme.indexOf('### Deploy to Render');
    const replitIdx = readme.indexOf('### Run on Replit');
    const vercelIdx = readme.indexOf('### Deploy to Vercel');
    assert.ok(renderIdx > -1 && replitIdx > -1 && vercelIdx > -1);
    assert.ok(renderIdx < replitIdx, 'Render section should come before the Replit section');
    assert.ok(replitIdx < vercelIdx, 'Replit section should come before the Vercel section');
  });
});

// --- submissions/railway-template.md --------------------------------------------

describe('submissions/railway-template.md', () => {
  it('exists', () => {
    assert.equal(fileExists('submissions/railway-template.md'), true);
  });

  it('starts with the expected title and references the merged PR', () => {
    assert.match(submissionDoc, /^# Railway Template Submission Guide/);
    assert.match(submissionDoc, /PR #52/);
  });

  it('lists DB_PATH as a required env var defaulting to /data/relay.db', () => {
    assert.match(
      submissionDoc,
      /\| `DB_PATH` \| SQLite database path — must match volume mount \| `\/data\/relay\.db` \| ✅ \|/,
    );
  });

  it('documents the volume mount path and size', () => {
    assert.match(submissionDoc, /Mount Path: `\/data`/);
    assert.match(submissionDoc, /Size: 1 GB/);
  });

  it('references the /health health check endpoint', () => {
    assert.match(submissionDoc, /Set the health check:\*\* `\/health`/);
  });

  it('documents the migration steps for an already-used deployment', () => {
    assert.match(submissionDoc, /Migrating an already-used deployment/);
    assert.match(submissionDoc, /SQLite online backup/);
    assert.match(submissionDoc, /ENCRYPTION_SECRET.*ENCRYPTION_SALT.*TOKEN_HMAC_SECRET/);
  });

  it('includes a testing script covering health, users, providers and stats endpoints', () => {
    const codeBlockMatch = submissionDoc.match(/```bash\n([\s\S]*?)```/);
    assert.ok(codeBlockMatch, 'expected a bash code block with test commands');
    const script = codeBlockMatch[1];
    assert.match(script, /curl \$RELAY\/health/);
    assert.match(script, /curl -X POST \$RELAY\/users/);
    assert.match(script, /curl \$RELAY\/providers/);
    assert.match(script, /curl -H "Authorization: Bearer <token-from-step-2>" \$RELAY\/stats/);
  });
});

// --- cross-file consistency ------------------------------------------------------

describe('cross-file consistency', () => {
  it('agrees on port 3000 across .replit env, .replit ports and railway.toml', () => {
    const replitEnvPort = replitConf.match(/\[env\]\s*\n\s*PORT\s*=\s*"(\d+)"/)[1];
    const replitLocalPort = replitConf.match(/localPort\s*=\s*(\d+)/)[1];
    const railwayPort = railwayEnvVarValue(railwayToml, 'PORT');

    assert.equal(replitEnvPort, '3000');
    assert.equal(replitLocalPort, '3000');
    assert.equal(railwayPort, '3000');
  });

  it('agrees on Node 20 across .replit, replit.nix and railway.toml', () => {
    const replitModules = tomlArray(replitConf, 'modules');
    assert.match(replitModules[0], /^nodejs-20:/);
    assert.ok(replitNix.includes('pkgs.nodejs_20'));

    const railwayVersion = railwayToml.match(/NIXPACKS_NODE_VERSION\s*=\s*"(\d+)"/)[1];
    assert.equal(railwayVersion, '20');
  });

  it('agrees on the DB_PATH default (/data/relay.db) across railway.toml, README and the submission doc', () => {
    const railwayDbPath = railwayEnvVarValue(railwayToml, 'DB_PATH');
    assert.equal(railwayDbPath, '/data/relay.db');

    const readmeBadge = extractBadges(readme).find((b) => b.alt === 'Deploy on Railway');
    const readmeDbPathDefault = new URL(readmeBadge.linkUrl).searchParams.get('DB_PATHDefault');
    assert.equal(readmeDbPathDefault, railwayDbPath);

    assert.ok(submissionDoc.includes('`/data/relay.db`'));
    assert.match(submissionDoc, /DB_PATH=\/data\/relay\.db/);
  });

  it('agrees on the /health health check path across railway.toml and the submission doc', () => {
    const railwayHealth = railwayToml.match(/healthcheckPath\s*=\s*"([^"]+)"/)[1];
    assert.equal(railwayHealth, '/health');
    assert.ok(submissionDoc.includes('`/health`'));
  });
});