# Privacy Policy Template for byok-relay Operators

> **This is a template.** If you run a self-hosted byok-relay instance for users, you need a privacy policy. This document gives you the structure — fill in the `[PLACEHOLDER]` values and have a lawyer review it before publishing.
>
> If you use the **managed relay** at `relay.byokrelay.com`, this document describes what the relay operator (byok-relay maintainer) collects and processes. For your own hosted instance, adapt accordingly.

---

## Privacy Policy for [YOUR APP NAME]

*Last updated: [DATE]*

### 1. What we collect

| Data | Purpose | Retention |
|------|---------|-----------|
| `app_id` (supplied at registration) | Identify which application a relay user belongs to | Until account deletion |
| Relay token (HMAC hash only — raw token never stored) | Authenticate subsequent requests | Until expiry or revocation |
| Encrypted API key(s) (AES-256-GCM ciphertext) | Forward AI provider requests on your behalf | Until you delete them (`DELETE /keys/:provider`) or your account (`DELETE /users`) |
| Request metadata (provider, model, HTTP status, latency_ms) | Operational logs, rate limiting, aggregate stats | [X] days |
| Request body (prompts, conversation history) | Proxied to AI provider; **not stored** unless you enable structured logging with body capture | Not stored by default |

We do **not** collect: names, email addresses, IP addresses beyond rate-limit windows, payment information, or any information beyond what is listed above.

### 2. Legal basis for processing (GDPR)

We process your data under **Article 6(1)(b)** (performance of a contract — providing the relay service you requested) and **Article 6(1)(f)** (legitimate interests — operating a secure, abuse-resistant relay).

### 3. Data residency

[PLACEHOLDER: Describe where your relay is hosted — cloud provider, region, e.g. "Our relay runs on AWS us-east-1. All data is stored within the United States."]

For the **managed relay at relay.byokrelay.com**: the relay runs on Vercel's infrastructure. See [SECURITY.md](SECURITY.md#data-residency-managed-relay) for details.

### 4. Subprocessors

| Subprocessor | Purpose | Data shared |
|---|---|---|
| [AI Provider, e.g. OpenAI] | AI inference | Request body (prompts), API key (via relay) |
| [Cloud host, e.g. Vercel] | Compute + network | Request metadata, encrypted keys at rest |
| [Log provider, if any] | Operational logs | Request metadata |

Your AI API key is transmitted to your chosen AI provider by the relay. We do not transmit it elsewhere.

### 5. Your rights (GDPR / CCPA)

- **Access:** `GET /stats` returns aggregate request counts for your relay token.
- **Deletion:** `DELETE /users` removes your account and all stored keys immediately (full erasure, no soft-delete).
- **Key deletion:** `DELETE /keys/:provider` removes a single provider key.
- **Token revocation:** `POST /tokens/revoke` immediately invalidates your relay token.
- **Portability:** We do not store your prompts or responses, so there is no conversation data to export. Stored keys are returned only as `{ provider, created_at }` metadata, never as plaintext.

To exercise rights not covered by the API, contact: [PLACEHOLDER: your contact email]

For CCPA requests (California residents): we do not sell personal data. Contact us at the address above for opt-out inquiries.

### 6. Data retention

- **Relay tokens:** Expire after `TOKEN_EXPIRY_DAYS` (default: 90 days). Revoked or expired tokens are deleted on the next cleanup cycle.
- **Encrypted API keys:** Stored until you delete them or your account.
- **Request logs (if enabled):** [PLACEHOLDER: X days]. Retained for operational debugging and aggregate stats only.
- **Rate-limit windows:** In-memory or Redis, cleared after the window expires (minutes, not days).

### 7. Security

We use AES-256-GCM encryption for all stored API keys. Raw keys are never logged or returned after initial registration. See [SECURITY.md](SECURITY.md) for the full threat model.

**Important:** Request bodies (your prompts and conversation history) pass through the relay in plaintext on the way to the AI provider. For sensitive data, self-host byok-relay on infrastructure you control.

### 8. Incident notification

In the event of a data breach affecting stored API keys or relay tokens, we will notify affected users within [PLACEHOLDER: 72 hours / as soon as practicable] and comply with applicable breach notification laws (GDPR Article 33, CCPA).

See [SECURITY.md](SECURITY.md#incident-response-runbook-for-relaybyokrelaycom-operators) for the operator incident response runbook.

### 9. Children

byok-relay is a developer tool. We do not knowingly collect data from anyone under 16.

### 10. Changes to this policy

We will post material changes here with a new "Last updated" date. Continued use of the relay after the effective date constitutes acceptance.

### 11. Contact

[PLACEHOLDER: Your name / company]
[PLACEHOLDER: Email address]
[PLACEHOLDER: Mailing address, if required by your jurisdiction]

---

## Notes for Operators

If you self-host byok-relay for users:

1. **You are the data controller.** Your users' encrypted API keys and relay tokens are your responsibility. byok-relay (the open-source project) is a processor in your stack, not the controller.
2. **GDPR Art. 28 DPA:** If your users are in the EU, you may need a Data Processing Agreement with your cloud provider and any subprocessors.
3. **Structured logging:** If you enable pino structured logging (`GET /stats` endpoint), request metadata is written to SQLite. Do not enable body logging unless you have a legal basis and have disclosed it in your privacy policy.
4. **`ENCRYPTION_SECRET` is critical.** If it leaks along with your `relay.db`, all stored API keys can be decrypted. Treat it like a root database password.
5. **Right to erasure:** `DELETE /users` implements GDPR Art. 17 — it permanently removes the user row and all associated keys in a single transaction. Wire this to your account deletion flow.
