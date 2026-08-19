/**
 * deploy-config.test.js — static validation of one-click deployment configs
 *
 * This PR adds/updates several deployment-related files that are not
 * executable Node.js code, but are still load-bearing for users clicking
 * "Deploy on Railway" / "Run on Replit" buttons:
 *
 *   - .replit                        (Replit run/deploy config)
 *   - replit.nix                     (Replit Nix system deps)
 *   - railway.toml                   (Railway build/deploy config)
 *   - README.md                      (deploy buttons + setup instructions)
 *   - submissions/railway-template.md (Railway marketplace submission notes)
 *
 * There is no TOML/Nix parser dependency in this project (by design — see
 * package.json), so these tests validate the raw file contents with
 * targeted string/regex checks rather than full syntax parsing. The goal
 * is to catch regressions like: a renamed env var that isn't updated
 * everywhere, a Node version that drifts between platforms, or a deploy
 * button URL that stops matching the documented defaults.
 *
 * Run:  npm test
 *       node --test test/e2e/deploy-config.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function readRoot(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const replit = readRoot('.replit');
const replitNix = readRoot('replit.nix');
const railwayToml = readRoot('railway.toml');
const readme = readRoot('README.md');
const submission = readRoot('submissions/railway-template.md');
const indexSrc = readRoot('src/index.js');
const dbSrc = readRoot('src/db.js');

describe('.replit — Replit run configuration', () => {
  it('pins the Node.js 20 module', () => {
    assert.match(replit, /^modules\s*=\s*\["nodejs-20:[^"]+"\]/m);
  });

  it('runs the app via npm start', () => {
    assert.match(replit, /^run\s*=\s*"npm start"$/m);
  });

  it('hides node_modules, package-lock.json, and .config from the file tree', () => {
    const match = replit.match(/^hidden\s*=\s*\[([^\]]*)\]/m);
    assert.ok(match, 'expected a top-level `hidden = [...]` array');
    const hidden = match[1];
    for (const entry of ['".config"', '"package-lock.json"', '"node_modules"']) {
      assert.ok(hidden.includes(entry), `expected hidden list to include ${entry}`);
    }
  });

  it('declares the stable-23_11 nix channel', () => {
    assert.match(replit, /\[nix\]\s*\nchannel\s*=\s*"stable-23_11"/);
  });

  it('sets PORT=3000 in [env]', () => {
    assert.match(replit, /\[env\]\s*\nPORT\s*=\s*"3000"/);
  });

  it('configures cloudrun deployment running npm start via sh -c', () => {
    assert.match(
      replit,
      /\[deployment\]\s*\nrun\s*=\s*\["sh",\s*"-c",\s*"npm start"\]\s*\ndeploymentTarget\s*=\s*"cloudrun"/,
    );
  });

  it('maps external port 80 to local port 3000', () => {
    assert.match(replit, /\[\[ports\]\]\s*\nlocalPort\s*=\s*3000\s*\nexternalPort\s*=\s*80/);
  });

  it('PORT value matches the server default in src/index.js', () => {
    const envPort = replit.match(/\[env\]\s*\nPORT\s*=\s*"(\d+)"/)[1];
    const defaultPortMatch = indexSrc.match(/const PORT = process\.env\.PORT \|\| (\d+);/);
    assert.ok(defaultPortMatch, 'expected src/index.js to define a numeric PORT default');
    assert.equal(envPort, defaultPortMatch[1]);
  });
});

describe('replit.nix — Replit system dependencies', () => {
  it('has balanced braces and brackets', () => {
    const opens = (replitNix.match(/[{[]/g) || []).length;
    const closes = (replitNix.match(/[}\]]/g) || []).length;
    assert.equal(opens, closes, 'replit.nix should have balanced { } and [ ] characters');
  });

  it('declares the expected deps list', () => {
    const depsMatch = replitNix.match(/deps\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(depsMatch, 'expected a `deps = [ ... ];` block');
    const deps = depsMatch[1];
    for (const dep of [
      'pkgs.nodejs_20',
      'pkgs.nodePackages.npm',
      'pkgs.python3',
      'pkgs.gcc',
      'pkgs.gnumake',
    ]) {
      assert.ok(deps.includes(dep), `expected deps to include ${dep}`);
    }
  });

  it('includes native build tools required to compile better-sqlite3', () => {
    // better-sqlite3 is a native addon; without a C compiler + make + python
    // (node-gyp's toolchain), `npm install` fails on a fresh Replit container.
    const pkgJson = JSON.parse(readRoot('package.json'));
    assert.ok(
      pkgJson.dependencies['better-sqlite3'],
      'expected better-sqlite3 to remain a dependency (sanity check for this test)',
    );
    assert.match(replitNix, /pkgs\.gcc/);
    assert.match(replitNix, /pkgs\.gnumake/);
    assert.match(replitNix, /pkgs\.python3/);
  });

  it('sets NODE_ENV=development for the Replit workspace', () => {
    assert.match(replitNix, /env\s*=\s*\{\s*\n\s*NODE_ENV\s*=\s*"development";/);
  });
});

describe('railway.toml — Railway deployment config', () => {
  it('uses the NIXPACKS builder pinned to Node 20', () => {
    assert.match(railwayToml, /\[build\]\s*\nbuilder\s*=\s*"NIXPACKS"/);
    assert.match(railwayToml, /\[build\.buildArgs\]\s*\nNIXPACKS_NODE_VERSION\s*=\s*"20"/);
  });

  it('configures startCommand, healthcheck, and restart policy', () => {
    assert.match(railwayToml, /startCommand\s*=\s*"npm start"/);
    assert.match(railwayToml, /healthcheckPath\s*=\s*"\/health"/);
    assert.match(railwayToml, /healthcheckTimeout\s*=\s*30/);
    assert.match(railwayToml, /restartPolicyType\s*=\s*"ON_FAILURE"/);
    assert.match(railwayToml, /restartPolicyMaxRetries\s*=\s*5/);
  });

  it('declares exactly the three expected [[deploy.envVars]] entries', () => {
    const blocks = railwayToml.match(/\[\[deploy\.envVars\]\]/g) || [];
    assert.equal(blocks.length, 3, 'expected NODE_ENV, PORT, and DB_PATH env var blocks');
  });

  it('sets NODE_ENV=production', () => {
    assert.match(
      railwayToml,
      /\[\[deploy\.envVars\]\]\s*\nname\s*=\s*"NODE_ENV"\s*\nvalue\s*=\s*"production"/,
    );
  });

  it('sets PORT=3000', () => {
    assert.match(
      railwayToml,
      /\[\[deploy\.envVars\]\]\s*\nname\s*=\s*"PORT"\s*\nvalue\s*=\s*"3000"/,
    );
  });

  it('sets DB_PATH to /data/relay.db to match the documented volume mount', () => {
    assert.match(
      railwayToml,
      /\[\[deploy\.envVars\]\]\s*\nname\s*=\s*"DB_PATH"\s*\nvalue\s*=\s*"\/data\/relay\.db"/,
    );
  });

  it('documents the required /data volume mount in comments', () => {
    assert.match(railwayToml, /Add Volume > Mount Path:\s*\/data/);
    assert.match(railwayToml, /Without a volume, relay\.db is on the ephemeral layer/);
  });
});

describe('README.md — deploy badges and setup instructions', () => {
  it('has a well-formed Replit badge/link at the top of the file', () => {
    const badges = readme.match(
      /\[!\[Run on Replit\]\(https:\/\/replit\.com\/badge\/github\/avikalpg\/byok-relay\)\]\(https:\/\/replit\.com\/github\/avikalpg\/byok-relay\)/g,
    );
    assert.ok(badges, 'expected at least one Replit badge/link pair');
    assert.ok(badges.length >= 2, 'expected the Replit badge in both the header and the Replit section');
  });

  it('Railway deploy button requests DB_PATH with the /data/relay.db default', () => {
    // The Railway button URL embeds literal, non-percent-encoded parentheses
    // (e.g. "(default: /data/relay.db)") inside the markdown link target, so
    // a naive "stop at the first )" regex would truncate mid-URL. Each badge
    // is the only markdown link on its line and the URL runs to the final
    // ")" that closes the markdown link, so extract per-line instead.
    const railwayLines = readme.split('\n').filter((l) => l.includes('railway.app/new/template'));
    assert.ok(railwayLines.length >= 2, 'expected Railway button in header and Railway section');
    const railwayButtons = railwayLines.map((line) => {
      const start = line.indexOf('https://railway.app/new/template');
      assert.ok(line.endsWith(')'), 'expected the markdown link line to end with a closing paren');
      return line.slice(start, -1);
    });
    for (const url of railwayButtons) {
      assert.match(url, /envs=ENCRYPTION_SECRET%2CALLOWED_ORIGINS%2CAPP_SECRET%2CDB_PATH/);
      assert.match(url, /DB_PATHDefault=%2Fdata%2Frelay\.db/);
    }
    // both occurrences should be byte-for-byte identical (no drift between
    // the header shortcut and the full Railway section)
    assert.equal(railwayButtons[0], railwayButtons[1]);
  });

  it('Railway section instructs users to add a volume before first use', () => {
    const railwaySection = readme.slice(readme.indexOf('### Deploy to Railway'), readme.indexOf('### Deploy to Render'));
    assert.match(railwaySection, /before registering users or storing keys/);
    assert.match(railwaySection, /Volumes\s*→\s*Add Volume/);
    assert.match(railwaySection, /mount path to `\/data`/);
    assert.match(railwaySection, /leave `DB_PATH` as `\/data\/relay\.db`/);
  });

  it('documents the migration path for deployments that predate the volume requirement', () => {
    const railwaySection = readme.slice(readme.indexOf('### Deploy to Railway'), readme.indexOf('### Deploy to Render'));
    assert.match(railwaySection, /Already used the relay without a volume\?/);
    assert.match(railwaySection, /SQLite online backup/);
    assert.match(railwaySection, /Keep the existing `ENCRYPTION_SECRET` and `TOKEN_HMAC_SECRET`/);
  });

  it('has a "Run on Replit" section with secrets setup steps', () => {
    assert.match(readme, /### Run on Replit \(browser-based, zero install\)/);
    const replitSection = readme.slice(
      readme.indexOf('### Run on Replit'),
      readme.indexOf('### Deploy to Vercel'),
    );
    assert.match(replitSection, /Replit \*\*Secrets\*\* tab/);
    for (const envVar of ['ENCRYPTION_SECRET', 'ALLOWED_ORIGINS', 'APP_SECRET']) {
      assert.ok(replitSection.includes(`\`${envVar}\``), `expected Replit section to mention ${envVar}`);
    }
  });

  it('Replit section does not tell users to configure DB_PATH (Railway-only concern)', () => {
    const replitSection = readme.slice(
      readme.indexOf('### Run on Replit'),
      readme.indexOf('### Deploy to Vercel'),
    );
    assert.ok(!replitSection.includes('DB_PATH'), 'DB_PATH is a Railway volume concept, not applicable to Replit');
  });

  it('warns that free Repls sleep and recommends Railway/Render for production', () => {
    const replitSection = readme.slice(
      readme.indexOf('### Run on Replit'),
      readme.indexOf('### Deploy to Vercel'),
    );
    assert.match(replitSection, /sleep after ~5 minutes of inactivity/);
    assert.match(replitSection, /use Railway or Render instead/);
  });

  it('every secret mentioned in the Replit steps is a real env var read by the server', () => {
    const replitSection = readme.slice(
      readme.indexOf('### Run on Replit'),
      readme.indexOf('### Deploy to Vercel'),
    );
    const mentioned = [...replitSection.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    for (const name of mentioned) {
      assert.ok(
        indexSrc.includes(`process.env.${name}`) || dbSrc.includes(`process.env.${name}`),
        `README mentions \`${name}\` for Replit setup, but no source file reads process.env.${name}`,
      );
    }
  });
});

describe('submissions/railway-template.md — Railway marketplace submission notes', () => {
  it('references the source PR and correct repository URL', () => {
    assert.match(submission, /PR #52/);
    assert.match(submission, /https:\/\/github\.com\/avikalpg\/byok-relay/);
  });

  it('documents DB_PATH with a default matching railway.toml', () => {
    assert.match(submission, /`DB_PATH`/);
    assert.match(submission, /\/data\/relay\.db/);
    // cross-check against the actual railway.toml value used in this PR
    const tomlDbPath = railwayToml.match(/name = "DB_PATH"\s*\nvalue = "([^"]+)"/)[1];
    assert.ok(submission.includes(tomlDbPath));
  });

  it('lists env vars that are all real, source-verified process.env reads', () => {
    const table = submission.slice(
      submission.indexOf('Configure environment variables'),
      submission.indexOf('Add a volume'),
    );
    const names = [...table.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    assert.ok(names.length > 0, 'expected the env var table to list at least one variable');
    for (const name of names) {
      assert.ok(
        indexSrc.includes(`process.env.${name}`) || dbSrc.includes(`process.env.${name}`),
        `submission doc lists \`${name}\`, but no source file reads process.env.${name}`,
      );
    }
  });

  it('documents the /data volume mount path', () => {
    assert.match(submission, /Mount Path:\s*`\/data`/);
  });

  it('healthcheck path matches railway.toml', () => {
    const tomlHealthPath = railwayToml.match(/healthcheckPath\s*=\s*"([^"]+)"/)[1];
    assert.ok(submission.includes(tomlHealthPath));
  });

  it('includes a testable curl walkthrough covering health, users, providers, and stats', () => {
    for (const endpoint of ['/health', '/users', '/providers', '/stats']) {
      assert.ok(submission.includes(endpoint), `expected curl example for ${endpoint}`);
    }
  });
});

describe('cross-file consistency between deployment configs', () => {
  it('pins the same Node major version across .replit, replit.nix, and railway.toml', () => {
    const replitNodeVersion = replit.match(/nodejs-(\d+):/)[1];
    const nixNodeVersion = replitNix.match(/pkgs\.nodejs_(\d+)/)[1];
    const railwayNodeVersion = railwayToml.match(/NIXPACKS_NODE_VERSION\s*=\s*"(\d+)"/)[1];
    assert.equal(replitNodeVersion, nixNodeVersion);
    assert.equal(nixNodeVersion, railwayNodeVersion);
  });

  it('uses the same PORT value in .replit and railway.toml', () => {
    const replitPort = replit.match(/\[env\]\s*\nPORT\s*=\s*"(\d+)"/)[1];
    const railwayPort = railwayToml.match(/name = "PORT"\s*\nvalue = "(\d+)"/)[1];
    assert.equal(replitPort, railwayPort);
  });

  it('uses the same DB_PATH default in railway.toml, README, and the submission doc', () => {
    const tomlDbPath = railwayToml.match(/name = "DB_PATH"\s*\nvalue = "([^"]+)"/)[1];
    const encodedPath = encodeURIComponent(tomlDbPath);
    assert.ok(readme.includes(`DB_PATHDefault=${encodedPath}`));
    assert.ok(submission.includes(tomlDbPath));
  });
});