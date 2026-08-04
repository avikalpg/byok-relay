# Security Policy

## Supported Versions

| Version | Status |
|---------|--------|
| Latest `main` | ✅ Supported |
| Older commits | ❌ Unsupported — please update |

byok-relay is pre-1.0. We do not backport fixes to older versions.

---

## Reporting a Vulnerability

**Do not post exploit details publicly before a fix is available.**

1. Open a GitHub issue titled **[Security] <short description>** — or
2. Email the maintainer directly at the address listed in `package.json`

Please include:
- Affected version / commit SHA
- Steps to reproduce
- Impact assessment (CVSS score or plain-language severity)
- Any suggested remediation

We aim to acknowledge reports within 48 hours and ship a fix within 7 days for critical issues.

---

## Incident Response Runbook (for relay.byokrelay.com operators)

This runbook applies to anyone running a self-hosted byok-relay instance. Follow these steps if you suspect a breach.

### Step 0 — Assess the scope

Ask: what was potentially accessed?

| Asset | Impact if exposed |
|-------|-------------------|
| `relay.db` (or backup) | Encrypted API keys readable if `ENCRYPTION_SECRET` is also known |
| `ENCRYPTION_SECRET` | Without `relay.db`, useless. With it: all stored API keys can be decrypted |
| Active relay tokens | Each token gives access to one user's stored keys until it expires or is revoked |
| Request logs (if pino / structured logging enabled) | Prompt text + provider responses in plaintext |

### Step 1 — Contain immediately

```bash
# Option A: take the relay offline temporarily
sudo systemctl stop byok-relay

# Option B: block ingress at the firewall (keep relay up for forensics)
sudo ufw deny 3000
```

Notify users that the relay is under maintenance.

### Step 2 — Revoke all active tokens

If you suspect relay tokens were exposed:

```bash
# Connect to the SQLite DB
sqlite3 /var/lib/byok-relay/relay.db

-- Invalidate every token immediately
UPDATE users SET expires_at = datetime('now') WHERE expires_at > datetime('now');
.quit
```

Alternatively, set `TOKEN_EXPIRY_DAYS=0` in your `.env` and restart — newly issued tokens will expire immediately, forcing re-registration.

### Step 3 — Rotate ENCRYPTION_SECRET

If `relay.db` **and** `ENCRYPTION_SECRET` were both exposed, all stored API keys must be treated as compromised.

1. Notify your users to rotate their API keys at each AI provider immediately (OpenAI, Anthropic, Google, etc.)
2. Stop the relay
3. Delete `relay.db` (all stored encrypted keys are now untrustworthy)
4. Generate a new `ENCRYPTION_SECRET`:
   ```bash
   openssl rand -hex 32
   ```
5. Update your environment and restart
6. Ask users to re-register with their new API keys

> **There is currently no automatic re-encryption tool.** Key rotation with `ENCRYPTION_SECRET` replacement requires users to re-add their keys. Tooling for this is planned but not yet shipped.

### Step 4 — Forensics

```bash
# Check auth logs for the relay process
journalctl -u byok-relay --since "2 days ago" | grep -E 'POST /users|POST /keys|POST /relay'

# Check nginx access logs for unusual IPs or paths
grep -E 'relay\.db|\.env|\/etc\/' /var/log/nginx/access.log
```

### Step 5 — Notify affected users

At minimum, email all registered users:
- What happened
- What data may have been exposed
- What they need to do (e.g., rotate API keys at their provider)
- When service will resume

GDPR Article 33 requires notifying your supervisory authority within 72 hours of becoming aware of a personal data breach.

### Step 6 — Post-incident

- Update your `ENCRYPTION_SECRET`, `APP_SECRET`, and `TOKEN_HMAC_SECRET`
- Enable Redis-backed rate limiting if not already set (`REDIS_URL`)
- Review nginx config for `.db` file exposure
- Consider moving `DB_PATH` outside the web root
- Open a GitHub issue (marked **[Security]**) so the community can learn from it

---

## Hardening Checklist

See the [Security section in README.md](README.md#security) for the full production hardening checklist.

---

## Known Limitations

- **Prompt content is not encrypted in transit through the relay.** Request bodies (including prompts and conversation history) pass through byok-relay in plaintext before reaching AI providers. For sensitive data, self-host on infrastructure you control.
- **No KMS integration out of the box.** `ENCRYPTION_SECRET` is an env var; there is no native AWS KMS / GCP Cloud KMS adapter yet.
- **SQLite is single-writer.** Concurrent writes bottleneck under high load. Use a Postgres backend for multi-replica deployments.

---

## Data Residency (Managed Relay)

`relay.byokrelay.com` runs on **Vercel** (serverless functions) with data stored in-region. The Vercel deployment uses the following data paths:

- **Request processing:** Vercel Edge Network — region routing based on requester location
- **SQLite DB:** Not persisted on Vercel (ephemeral filesystem) — the managed relay uses an external persistent store
- **Logs:** Vercel function logs — retained per Vercel's default log retention policy (accessible to the relay operator)

**What transits the managed relay:**
- Your relay token (used to look up the stored encrypted API key)
- The full request body (prompt, model, messages) — in plaintext on the relay server
- The full response from the AI provider — streamed back to your browser

**For production apps with sensitive data or paying users: self-host.** The managed relay is for prototyping and development.

See [Vercel's Privacy Policy](https://vercel.com/legal/privacy-policy) for Vercel's data handling commitments.
