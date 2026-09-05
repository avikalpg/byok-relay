# byok-relay — Community Post Drafts

> **Approval-gated drafts. Do not publish externally until Avi approves.** Each post is tuned for its platform's tone and norms.
> "Show don't tell" format throughout: working code, real numbers, no pure marketing copy.

---

## r/selfhosted

**Title:** `Self-hosted BYOK relay for AI apps — your users bring their own API keys, no CORS, one command to run`

**Post:**

Built this because I kept hitting the same problem: you want to let users of your app connect their own OpenAI / Anthropic / Gemini key, but you can't call those APIs from a browser (CORS), and you can't put the key in frontend code.

**byok-relay** is a small Node server that solves this. Your users enter their API key in your app's settings. It gets AES-256-GCM encrypted, stored in a local SQLite DB (you control), and the relay forwards requests to the AI provider on their behalf.

**Self-host in 30 seconds:**

```bash
git clone https://github.com/avikalpg/byok-relay
cd byok-relay
cp .env.example .env   # fill in ENCRYPTION_SECRET
docker compose up
```

Or with npm:

```bash
npx byok-relay
```

**What it supports:**
- OpenAI, Anthropic, Google Gemini, Mistral, Groq, Cohere, Together AI, Perplexity
- ElevenLabs, Deepgram, HuggingFace (audio + binary streaming)
- Streaming SSE, multimodal / vision (raw body pass-through, no re-serialization)
- Per-user usage stats: `GET /stats`
- Key rotation: `POST /keys/:provider/rotate` (verifies new key before swapping)
- Token expiry + revocation
- Rate limiting (Redis-backed for multi-process; in-memory fallback for single-process)
- SSRF protection (RFC-1918 blocklist + DNS rebinding defence)

**Performance:** relay adds ~0.014ms median overhead (p99 = 0.041ms). Measured, not estimated — benchmark script in `scripts/bench-cpu.js`.

Repo: https://github.com/avikalpg/byok-relay
Managed relay (for testing): https://byokrelay.com

It's MIT. Happy to answer questions or take PRs.

---

## r/webdev

**Title:** `I built a CORS-safe relay so Lovable/Bolt/Cursor apps can let users bring their own AI API key`

**Post:**

If you're shipping a frontend-only app (Lovable, Bolt.new, Cursor, plain Vite/React), you've probably hit this wall:

- You can't call OpenAI directly from the browser — CORS
- You can't put your API key in the bundle — leaked instantly
- Adding a backend just for key management feels like overkill

I built **byok-relay** to solve this. It's a tiny self-hostable relay that:

1. **User enters their own API key** in your app's settings UI
2. Key is **AES-256-GCM encrypted**, stored on your server (or on byokrelay.com for prototypes)
3. Your app calls `/relay/openai/...` instead of `api.openai.com` — relay decrypts key, forwards request, streams response

**Frontend integration (5 minutes):**

```js
import { createClient } from '@byok-relay/client';

const relay = createClient({ relayUrl: 'https://byokrelay.com' });
await relay.register({ appId: 'my-app' });
await relay.storeKey('openai', userEnteredKey);

// Now call OpenAI through the relay — streaming works
const stream = await relay.streamChat({
  provider: 'openai',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }]
});
```

Works with the supported providers listed above: OpenAI, Anthropic, Gemini, ElevenLabs, Deepgram, and HuggingFace.

**Integration guides** for Lovable, Bolt.new, Framer, Next.js, plain Vite are in `INTEGRATIONS.md`:
https://github.com/avikalpg/byok-relay/blob/main/INTEGRATIONS.md

Self-host with docker compose or `npx byok-relay`. MIT license.

https://github.com/avikalpg/byok-relay

---

## r/IndieHackers

**Title:** `How I let users bring their own AI API key — and why it changes the unit economics of AI apps`

**Post:**

One pattern I've seen working well for solo builders: instead of marking up AI API calls (or building a token system), let users bring their own API key.

**Why this works for indiehackers:**

- No AI cost exposure — you don't pay OpenAI, they do
- No billing infrastructure to build at the start
- Power users (who have API credits from their employer, research accounts, etc.) love it
- Reduces trust friction: "I'm paying my own AI provider, not handing my money to yet another startup"

The catch: you can't do BYOK from a frontend app. You need a relay to handle CORS and to store the key securely without exposing it in the bundle.

I built **byok-relay** to be that relay. It's self-hostable, MIT-licensed, and takes about 5 minutes to integrate.

**The unit economics shift:**

| | Traditional (you pay) | BYOK (user pays) |
|---|---|---|
| AI provider cost per session/user | ~$0.01–0.10/session | $0.00 (paid directly by the user) |
| Billing infra needed | Yes | No |
| User trust barrier | Medium (give us $ + data) | Lower (give us data only) |
| Best for | Mainstream users | Power users, developers |

Works best when your users are technical enough to have an API key (or willing to get one in 5 min). Hosting, storage, and bandwidth still have infrastructure costs. Not a fit for consumer apps where users don't know what an API key is.

Repo: https://github.com/avikalpg/byok-relay
Demo / managed relay: https://byokrelay.com

Happy to discuss the model — curious if others have tried BYOK as a revenue strategy and how it worked.

---

## Hacker News — Show HN (see also show-hn.md, blocked until Avi approves)

**Title:** `Show HN: byok-relay – self-hostable BYOK relay for frontend-only AI apps`

**Post:**

byok-relay lets frontend-only apps (Lovable, Bolt.new, Cursor, plain Vite/React) use AI APIs without embedding a server-controlled provider key in the frontend or hitting CORS.

The model: users enter their own OpenAI / Anthropic / Gemini key in your app's settings. The relay encrypts it (AES-256-GCM) and stores it in a local SQLite DB. Your frontend calls the relay instead of the AI provider directly — relay decrypts the key per-request, forwards the call, pipes back the response (including streaming and binary).

The managed relay at byokrelay.com is free for prototypes. For production: `npx byok-relay` or `docker compose up`.

Supports: OpenAI, Anthropic, Google Gemini, Mistral, Groq, Together AI, Perplexity, ElevenLabs, Deepgram, HuggingFace. Streaming SSE + binary pass-through (audio, video). Per-user stats at `GET /stats`. Redis-backed rate limiting for multi-process.

Source: https://github.com/avikalpg/byok-relay (MIT)

---

## Lovable / Bolt.new Discord (short format)

```text
Built a CORS-safe relay so your Lovable apps can let users bring their own OpenAI/Anthropic key.

No backend needed — just point your app at the relay URL:
• Managed (free for prototypes): https://byokrelay.com
• Self-host: npx byok-relay

INTEGRATIONS.md has a copy-paste Lovable integration guide:
https://github.com/avikalpg/byok-relay/blob/main/INTEGRATIONS.md

MIT, open source. Happy to help integrate.
```
