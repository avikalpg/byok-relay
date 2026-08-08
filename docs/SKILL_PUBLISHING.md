# Skill Publishing & CI/CD

This document explains how the byok-relay skill is automatically published to ClawHub and synced to the website.

## Overview

The byok-relay skill is published to multiple locations:

1. **ClawHub Registry** (https://clawhub.ai) — discoverable by AI agents
2. **Website** (https://www.byokrelay.com/skill) — served via `public/skill`
3. **GitHub** (https://github.com/avikalpg/byok-relay/tree/main/skills/byok-relay) — source of truth

## Automatic Publishing Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. Dev updates skills/byok-relay/SKILL.md on main branch   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  2. GitHub Actions workflow triggers                         │
│     - Auto-increments patch version (or manual major/minor)  │
│     - Publishes to ClawHub with new version                  │
│     - Commits version bump back to repo                      │
│     - Creates git tag (skill-vX.Y.Z)                         │
│     - Triggers Vercel Deploy Hook                            │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Vercel rebuilds website                                  │
│     - prebuild script curls latest SKILL.md from GitHub      │
│     - Copies it to public/skill                              │
│     - Website now serves updated skill at /skill endpoint    │
└─────────────────────────────────────────────────────────────┘
```

## Version Management

Version is tracked in `skills/byok-relay/VERSION` (semver format: `MAJOR.MINOR.PATCH`).

### Automatic Version Bumps

On every push to `main` that modifies `skills/byok-relay/**`:
- **Patch version** is auto-incremented (e.g., `1.0.0` → `1.0.1`)
- Changelog is auto-generated from commit messages

### Manual Version Bumps

For minor or major releases, trigger the workflow manually:

```bash
# Via GitHub UI: Actions → Publish Skill Updates → Run workflow
# Select version_bump: minor | major | patch
# Add custom changelog entry
```

Or via `gh` CLI:

```bash
gh workflow run publish-skill.yml \
  -f version_bump=minor \
  -f changelog="Added support for custom provider base URLs"
```

## Required Secrets

The GitHub workflow requires these secrets (set in repo Settings → Secrets):

| Secret | Purpose | How to get |
|--------|---------|-----------|
| `CLAWHUB_API_TOKEN` | Authenticate with ClawHub | Run `clawhub login`, then copy token from `~/.config/clawhub/config.json` |
| `VERCEL_DEPLOY_HOOK_URL` | Trigger website rebuild | Vercel Project Settings → Git → Deploy Hooks → Create Hook |

## Manual Publishing (fallback)

If the CI/CD fails, you can manually publish:

```bash
# 1. Authenticate
clawhub login --token YOUR_TOKEN

# 2. Publish
clawhub publish ./skills/byok-relay \
  --slug byok-relay \
  --name "BYOK Relay Builder" \
  --version X.Y.Z \
  --changelog "Your changelog"

# 3. Update VERSION file
echo "X.Y.Z" > skills/byok-relay/VERSION
git add skills/byok-relay/VERSION
git commit -m "chore: bump skill version to X.Y.Z"
git push

# 4. Trigger Vercel rebuild manually or wait for next deploy
```

## Troubleshooting

### "MIT-0 license terms must be accepted"

Sign in to https://clawhub.ai with your GitHub account and accept the license terms in your profile/settings.

### Vercel deploy hook not triggering

1. Check that `VERCEL_DEPLOY_HOOK_URL` secret is set in GitHub repo
2. Verify the URL is correct (test with `curl -X POST "$URL"`)
3. Check Vercel deployment logs for errors

### Website not showing updated skill

The `prebuild` script in `byok-relay-website/package.json` fetches the skill from:
```
https://raw.githubusercontent.com/avikalpg/byok-relay/main/skills/byok-relay/SKILL.md
```

If the skill isn't updating:
1. Verify the file exists at that URL
2. Check Vercel build logs for curl errors
3. Clear Vercel cache and redeploy

### Version conflicts

If the workflow fails due to a version conflict:
1. Manually set the correct version in `skills/byok-relay/VERSION`
2. Commit and push to main
3. Re-run the workflow

## Future Improvements

- [ ] Add ClawHub skill analytics dashboard link
- [ ] Auto-generate changelogs from conventional commits
- [ ] Slack/Discord notification on successful publish
- [ ] Pre-publish validation (lint SKILL.md frontmatter)
- [ ] Support for beta/alpha releases (e.g., `1.0.0-beta.1`)
