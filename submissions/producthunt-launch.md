# byok-relay — Product Hunt Launch Kit

> Internal launch guide. Do not commit secrets. All copy below is final-draft quality — review before posting.

---

## Launch Basics

| Field | Value |
|---|---|
| **Name** | byok-relay |
| **Tagline** | The missing backend for Lovable, Bolt & Cursor apps |
| **Website** | https://byokrelay.com |
| **Topics** | Developer Tools · Artificial Intelligence · Open Source |
| **Makers** | @avikalpg |

### Tagline alternatives (pick one, 60-char limit)

1. `The missing backend for Lovable, Bolt & Cursor apps` ← recommended
2. `CORS-safe AI relay — your users bring their own API key`
3. `Self-hostable BYOK relay for frontend-only AI apps`
4. `Ship AI apps without storing a single user API key`

---

## Gallery (what to screenshot / record)

Suggested 5-image sequence:

| # | Description | What to show |
|---|---|---|
| 1 | **Hero diagram** | The 3-step flow: frontend → byok-relay → AI provider (use the README flow diagram) |
| 2 | **3-command self-host** | `docker compose up` in terminal — server starts on port 3000 |
| 3 | **Client integration** | `@byok-relay/client` npm install + 10-line relay.js snippet |
| 4 | **INTEGRATIONS.md** | Split view: Lovable prompt on left, generated ApiKeySettings UI on right |
| 5 | **GET /stats** response | JSON showing per-app request counts, providers used, error rates |

**Loom / GIF** (optional but high-impact): record `npx byok-relay` startup + a curl relay request returning a streaming response. 30-second max.

---

## Description (shown in Gallery tab, ~260 chars for subtitle)

> byok-relay is a self-hostable, zero-backend relay that lets your AI app's users bring their own API keys — no CORS, no keys in frontend code, no vendor lock-in. Keys are encrypted at rest on the relay. Works with Lovable, Bolt, Cursor, plain Vite, and any frontend that talks HTTP.

---

## Maker's First Comment (post this yourself immediately after launch)

Hey Product Hunt 👋

I built byok-relay to solve a problem I kept hitting: **you can't call OpenAI, Anthropic, or Gemini directly from a browser** because the APIs don't allow CORS, and you can't put your API key in frontend code without leaking it.

The usual fix is "build a backend." That's fine if you have one — but Lovable, Bolt.new, and Cursor are generating thousands of frontend-only apps where there's no server to put the key management on.

byok-relay is that missing piece:

- **Zero lines of backend code** — drop in one relay URL, your users enter their own API key
- **Self-hostable in one command** — `npx byok-relay` or `docker compose up`
- **All the major providers** — OpenAI, Anthropic, Gemini, Mistral, Groq, ElevenLabs, Deepgram, HuggingFace
- **Streaming, multimodal, binary** — vision requests, audio, the works; no re-serialization
- **No vendor lock-in** — open-source Apache 2.0, your data stays on your infrastructure

The managed relay at https://relay.byokrelay.com is free for prototypes. For production, self-host in one command.

Happy to answer any questions about the architecture, the BYOK model, or why this approach beats "just add a serverless function." AMA!

— Avikalp (avikalpg on GitHub)

---

## Launch Checklist

### Before posting

- [ ] Merge all open PRs to main (ask Avi to merge the queued PRs)
- [ ] Tag `v1.0.0` in the byok-relay repo (npm-publish workflow will auto-publish)
- [ ] Check `npx byok-relay --version` works
- [ ] Verify byokrelay.com landing page is live and fast
- [ ] Prepare 3–5 gallery images (screenshots as above)
- [ ] Optionally record a 30-second Loom / GIF demo

### Timing

- **Best day:** Tuesday–Thursday, launch at midnight PST (03:00 EST / 08:00 UTC)
- **Avoid:** Mondays (Product Hunt resets, crowded) and Fridays (low traffic)
- Coordinate with DevHunt (see `submissions/devhunt-launch.md`) — run DevHunt a few days before PH for a warm-up

### Launch day actions

- [ ] Post in @makers Slack with your PH link (community upvote boost)
- [ ] Share on your personal Twitter/X (@AvikalpGupta) — "We're live on Product Hunt!"
- [ ] Share in relevant Discord servers: Lovable, Bolt.new, Cursor
- [ ] Post in r/selfhosted and r/webdev pointing to the PH page (not the repo directly)
- [ ] Notify your email list / any newsletter subscribers
- [ ] Engage with every comment on PH within the first 2 hours

---

## Outreach List (to notify day-of)

| Person / Community | Where | Message |
|---|---|---|
| Lovable Discord | #general or #tools | "Built a CORS-safe BYOK relay for Lovable apps — live on PH today" |
| Bolt.new Discord | #resources | Same angle |
| Hacker News | new.ycombinator.com/submit | Show HN post (see show-hn.md) |
| r/selfhosted | reddit.com/r/selfhosted | See reddit-posts.md |
| r/webdev | reddit.com/r/webdev | See reddit-posts.md |
| r/IndieHackers | reddit.com/r/indiehackers | See reddit-posts.md |

---

## DevHunt Launch (separate, run before PH)

DevHunt (devhunt.org) is specifically for developer tools — less competition, engaged niche audience, good inbound signal for PH.

- Create account at devhunt.org
- Fill in: name=byok-relay, tagline (same as PH), website=byokrelay.com, GitHub=avikalpg/byok-relay
- Launch 2–3 days before Product Hunt to warm up momentum

---

## FAQ Prep (expected PH questions)

**Q: Why not just use OpenRouter / LiteLLM?**
A: OpenRouter and LiteLLM are vendor-managed proxies — users pay through the vendor's billing. byok-relay is BYOK: each user brings their own API key, paying their provider directly. You control the infra; they control their keys.

**Q: Is the managed relay safe to use?**
A: For prototypes and demos, yes. For production with paying users, self-host — it's one command. The managed relay is transparent about what transits (prompts, not keys) in the README.

**Q: What happens if relay.byokrelay.com goes down?**
A: Nothing changes for self-hosted users. For managed-relay users, switch the relay URL to your own instance. Zero vendor lock-in.

**Q: Does this work with Vercel / serverless?**
A: byok-relay uses SQLite which is ephemeral on Vercel. Use Railway (recommended) or Render for production self-hosting. Vercel is fine for demos.

**Q: Why Apache 2.0 and not AGPL / source-available?**
A: Maximum adoption. We want this in as many apps as possible. Commercial use is welcome.
