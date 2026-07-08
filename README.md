# byok-relay

**Website:** [byokrelay.com](https://byokrelay.com) | **Hosted relay:** [relay.byokrelay.com](https://relay.byokrelay.com)

[![skills.sh](https://skills.sh/b/avikalpg/byok-relay)](https://skills.sh/avikalpg/byok-relay)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

**Your users already have AI keys. byok-relay lets them use those keys — straight from your frontend, with no CORS issues and no keys in your code.**

Built for developers building prosumer tools and B2B AI products. Whether you're running a frontend-only app or have a full backend, byok-relay handles the BYOK plumbing — encrypted key storage, secure relay, multi-provider support — in minutes, not days. Your users bring their own OpenAI, Anthropic, or Gemini keys; you build the product; they pay for their own AI usage.

## Managed relay

**Skip the setup — use ours:**

```
https://relay.byokrelay.com
```

Free to use. Open CORS (any origin). [Health check →](https://relay.byokrelay.com/health)

## SolidJS reactive stores

```bash
npm install @byok-relay/solid
```

```jsx
import { createByokRelayStore, createStreamingChatStore } from '@byok-relay/solid';

function App() {
  const relay = createByokRelayStore({ appId: 'my-app' });
  const chat  = createStreamingChatStore({ provider: 'openai', model: 'gpt-4o-mini' });

  async function send(text) {
    if (!relay.token()) await relay.register();
    await chat.sendMessage(text, relay.token());
  }

  return (
    <>
      <For each={chat.messages()}>{msg => <p>{msg.role}: {msg.content}</p>}</For>
      <Show when={chat.streamingContent()}><p>assistant: {chat.streamingContent()}▋</p></Show>
    </>
  );
}
```

Also available: [`@byok-relay/react`](https://npmjs.com/package/@byok-relay/react), [`@byok-relay/vue`](https://npmjs.com/package/@byok-relay/vue), [`@byok-relay/svelte`](https://npmjs.com/package/@byok-relay/svelte), [`@byok-relay/angular`](https://npmjs.com/package/@byok-relay/angular)

## Angular injectable services

```bash
npm install @byok-relay/angular
```

```typescript
import { Component, inject } from '@angular/core';
import { ByokRelayService, ChatService, provideByokRelay } from '@byok-relay/angular';

// app.config.ts
export const appConfig = {
  providers: [provideByokRelay({ relayUrl: 'https://relay.byokrelay.com' })],
};

// chat.component.ts
@Component({ template: `
  <div *ngFor="let m of chat.messages()">{{ m.role }}: {{ m.content }}</div>
  <button (click)="send('Hello!')">Send</button>
` })
export class ChatComponent {
  relay = inject(ByokRelayService);
  chat  = inject(ChatService);

  async ngOnInit() { await this.relay.getOrRegister('my-app'); }
  async send(text: string) { await this.chat.sendMessage(text); }
}
```

Signals (Angular 16+), `StreamingChatService` (SSE + AbortController), `RelayHealthService` (polling), and Analog SSR support included. [Full docs →](packages/angular/README.md)

### Remix / React Router v7 integration (`@byok-relay/remix`)

Loader and action factories that keep `RELAY_URL` server-only, plus React hooks for Remix's hydration model:

```bash
npm install @byok-relay/remix
```

```ts
// app/routes/api.relay.$.tsx  (catch-all route)
import { createRelayLoader, createRelayAction } from '@byok-relay/remix';
export const loader = createRelayLoader({ relayUrl: process.env.RELAY_URL });
export const action = createRelayAction({ relayUrl: process.env.RELAY_URL });
```

```tsx
// app/components/AiChat.tsx
import { useByokRelay, useStreamingChat } from '@byok-relay/remix';

export function AiChat() {
  const { token } = useByokRelay({ relayUrl: window.ENV.RELAY_URL });
  const { messages, streamingContent, send, stopStreaming } = useStreamingChat({
    relayUrl: window.ENV.RELAY_URL,
    token,
    provider: 'openai',
    model: 'gpt-4o-mini',
  });
  return <>{/* render messages + streamingContent */}</>;
}
```

Also includes `ByokRelayClient` (plain-JS class, works in both loaders and browser scripts) and `useRelayHealth`. Compatible with React Router v7 framework mode. [Full docs →](packages/remix/README.md)

### Astro SSR integration (`@byok-relay/astro`)

For Astro SSR apps, keep the relay URL private in server env vars:

```bash
npm install @byok-relay/astro
```

```ts
// src/pages/api/relay/[...path].ts
import { createRelayApiRoute } from '@byok-relay/astro';
export const prerender = false;
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createRelayApiRoute({
  relayUrl: import.meta.env.RELAY_URL,  // server-only — never in the browser bundle
});
```

```astro
<!-- Any .astro page or component -->
<script>
  import { ByokRelayClient } from '@byok-relay/astro';
  const relay = new ByokRelayClient({ relayUrl: '/api/relay', appId: 'my-app' });
  await relay.storeKey('openai', userApiKey);
  const reply = await relay.chat({
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello!' }],
  });
</script>
```

Also includes `createByokRelayMiddleware` for a `src/middleware.ts` proxy, and `ByokRelayClient.streamChat()` with SSE streaming for View Transitions. [Full docs →](packages/astro/README.md)

### Preact hooks (`@byok-relay/preact`)

For Preact apps, **Astro component islands**, or any Vite/Preact project:

```bash
npm install @byok-relay/preact
```

```jsx
import { useStreamingChat, useByokRelay } from '@byok-relay/preact';

export function ChatIsland() {
  const { storeKey } = useByokRelay({
    relayUrl: import.meta.env.PUBLIC_RELAY_URL,
    appId: 'astro-app',
  });

  const { messages, streamingContent, isStreaming, sendMessage, stopStreaming } = useStreamingChat({
    relayUrl: import.meta.env.PUBLIC_RELAY_URL,
    appId: 'astro-app',
    provider: 'openai',
    model: 'gpt-4o-mini',
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      {isStreaming && <p><em>{streamingContent}</em></p>}
      <button onClick={() => sendMessage('Hello!')}>Send</button>
      {isStreaming && <button onClick={stopStreaming}>Stop</button>}
    </div>
  );
}
```

SSR-safe (no `window` access during server render). Works with `client:load`, `client:visible`, and `client:idle` Astro directives. [Full docs →](packages/preact/README.md)

### Vercel AI SDK (`@byok-relay/vercel-ai`)

For Next.js, SvelteKit, Nuxt, or any project using the Vercel AI SDK:

```bash
npm install @byok-relay/vercel-ai
```

```ts
import { createByokRelayProviderSync } from '@byok-relay/vercel-ai';
import { streamText, generateText, generateObject } from 'ai';

const provider = createByokRelayProviderSync({
  relayUrl: process.env.BYOK_RELAY_URL!,
  appId: 'my-app',
});

// One-time setup: store user's API key
await provider.storeKey('openai', userApiKey);

// Works with every AI SDK function
const result = streamText({
  model: provider.languageModel('openai/gpt-4o'),
  messages,
});
return result.toDataStreamResponse();
```

Supports `generateText`, `streamText`, `generateObject`, tool calling, vision inputs. Model IDs: `'openai/gpt-4o'`, `'anthropic/claude-3-5-sonnet-20241022'`, `'groq/llama3-70b-8192'`, bare model names (default: OpenAI). [Full docs →](packages/vercel-ai/README.md)

### Hono middleware (`@byok-relay/hono`)

For [Hono](https://hono.dev) apps on **Cloudflare Workers, Deno Deploy, Bun, or Node.js**. Keeps `RELAY_URL` server-side only via Hono's context env:

```bash
npm install @byok-relay/hono
```

```typescript
// Cloudflare Workers — src/worker.ts
import { Hono } from 'hono';
import { createByokRelayMiddleware } from '@byok-relay/hono';

const app = new Hono<{ Bindings: { RELAY_URL: string } }>();

// Mount the proxy — RELAY_URL read from c.env (Workers binding), never in the bundle
app.use('/relay/*', createByokRelayMiddleware());

export default app;
```

```typescript
// Bun / Node.js — explicit catch-all route
import { createRelayRoute } from '@byok-relay/hono';
app.all('/relay/*', createRelayRoute({ relayUrl: process.env.RELAY_URL }));
```

Includes `ByokRelayClient` for server-side usage (route handlers, scheduled Workers) with in-memory storage and optional custom adapter for Workers KV. [Full docs →](packages/hono/README.md)

### Next.js App Router (`@byok-relay/next`)

Route Handler factory, middleware, and React hooks for **Next.js 13+ App Router**. `RELAY_URL` stays in `process.env` — the browser only calls your own API route:

```bash
npm install @byok-relay/next
```

```js
// app/api/relay/[...path]/route.js — RELAY_URL is server-only
import { createRelayRouteHandler } from '@byok-relay/next';
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } =
  createRelayRouteHandler({ relayUrl: process.env.RELAY_URL });
```

```jsx
// 'use client' component — point at your own route, not the upstream relay
'use client';
import { useByokRelay, useStreamingChat } from '@byok-relay/next';

export function ChatBox () {
  const { token, registerUser } = useByokRelay({ relayUrl: '/api/relay' });
  const { messages, streamingContent, sendMessage, stopStreaming } =
    useStreamingChat({ relayUrl: '/api/relay', token, model: 'openai/gpt-4o' });
  // ...
}
```

Also includes `ByokRelayClient` for Server Components and Server Actions (accepts a custom `storage` adapter for cookies/session). [Full docs →](packages/next/README.md)

## For AI coding agents

If you're using a coding agent (Cursor, Claude Code, Copilot, Codex, etc.), install the skill and let it handle the integration:

```bash
npx skills add avikalpg/byok-relay
```

Or point your agent directly at the skill file:

```
https://byokrelay.com/skill
```

> Prompt: *"Read the byok-relay skill at https://byokrelay.com/skill and integrate byok-relay into this project using the hosted relay at https://relay.byokrelay.com"*

## The problem

Browser apps can't call AI APIs directly:
- `api.anthropic.com`, `api.openai.com`, and most AI providers **block browser requests via CORS**
- Putting API keys in frontend code exposes them to every user

The common workaround — a backend proxy — means the *app developer* holds the keys. That's a trust problem, and it puts inference costs on your bill permanently.

**byok-relay solves this differently:** the relay sits between your frontend and the AI provider. Users register their own keys once; every request after that uses their key, billed to their account.

## How it compares

| | byok-relay | OpenRouter | LiteLLM |
|---|---|---|---|
| Who holds the API keys | Your users | OpenRouter | Your org |
| Who pays for AI usage | Your users | You (the dev) | You (the org) |
| BYOK for end users | ✅ | ❌ | ❌ |
| Browser-safe (CORS handled) | ✅ | ✅ | ❌ (needs backend) |
| Self-hosted | ✅ | ❌ | ✅ |
| Open source | ✅ Apache 2.0 | ❌ | ✅ |
| Model routing / fallbacks | ❌ | ✅ | ✅ |

Use OpenRouter or LiteLLM when you're paying for your users' AI and want routing + analytics. Use byok-relay when you want users to bring their own keys.

## How it works

```
Browser                  byok-relay              AI Provider
  │                           │                       │
  ├─ POST /users ────────────►│                       │
  │◄─ { token } ─────────────┤                       │
  │                           │                       │
  ├─ POST /keys/anthropic ───►│                       │
  │  { key: "sk-ant-..." }    │ (stored encrypted)    │
  │◄─ { ok: true } ──────────┤                       │
  │                           │                       │
  ├─ POST /relay/anthropic ──►│                       │
  │  x-relay-token: <token>   ├─ (real key injected) ►│
  │  { model, messages... }   │                       │
  │◄─ streamed response ──────┤◄─ streamed response ──┤
```

The `token` (not the API key) lives in the browser. The API key stays server-side, encrypted at rest with AES-256-GCM.

## Quickstart (60 seconds)

```bash
# 1. Clone and install
git clone https://github.com/avikalpg/byok-relay.git && cd byok-relay && npm install

# 2. Configure
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=http://localhost:3000" >> .env

# 3. Start (add APP_SECRET for production to restrict who can register users)
# echo "APP_SECRET=$(openssl rand -hex 32)" >> .env
npm start &

# 4. Register a user and get a token
TOKEN=$(curl -s -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"app_id":"test"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 5. Store your Anthropic key
curl -X POST http://localhost:3000/keys/anthropic \
  -H "Content-Type: application/json" \
  -H "x-relay-token: $TOKEN" \
  -d '{"key":"sk-ant-YOUR-KEY-HERE"}'

# 6. Relay a request (streaming)
curl -X POST http://localhost:3000/relay/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-relay-token: $TOKEN" \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

## Supported providers

| Provider | Name | Notes |
|---|---|---|
| Anthropic | `anthropic` | Claude models, SSE streaming |
| OpenAI | `openai` | GPT models, SSE streaming |
| Google | `google` | Gemini API (key in query param) |
| Groq | `groq` | Fast inference, OpenAI-compatible |
| OpenRouter | `openrouter` | 200+ models via one API |
| Mistral | `mistral` | Mistral models |
| Any OpenAI-compatible | `openai-compatible` | Pass `x-relay-base-url` header — covers LiteLLM, Ollama, Perplexity, Together AI, and any other OpenAI-compatible endpoint |

Adding a new built-in provider is ~5 lines in `src/providers.js`.

## API

### Register a user
```http
POST /users
Content-Type: application/json

{ "app_id": "my-app" }
```
→ `{ "token": "<relay-token>" }` — store in browser localStorage

> **If `APP_SECRET` is set**, the request must include `Authorization: Bearer <secret>`:
> ```http
> POST /users
> Content-Type: application/json
> Authorization: Bearer <APP_SECRET>
> 
> { "app_id": "my-app" }
> ```
> Without a valid `Authorization` header, the server returns `401 Unauthorized`.

### Store an API key
```http
POST /keys/anthropic
x-relay-token: <token>
Content-Type: application/json

{ "key": "sk-ant-..." }
```

### List stored providers (key values never returned)
```http
GET /keys
x-relay-token: <token>
```

### Delete a key
```http
DELETE /keys/anthropic
x-relay-token: <token>
```

### Relay a request
```http
POST /relay/anthropic/v1/messages
x-relay-token: <token>
Content-Type: application/json
anthropic-version: 2023-06-01

{ "model": "claude-3-5-haiku-20241022", "max_tokens": 1024, "messages": [...], "stream": true }
```
Full streaming (SSE) is supported — the response is piped directly from the provider to the browser.

### Generic OpenAI-compatible relay
```http
POST /relay/openai-compatible/v1/chat/completions
x-relay-token: <token>
x-relay-base-url: https://openrouter.ai
Content-Type: application/json

{ "model": "...", "messages": [...] }
```

## Deploy in one click

The fastest way to get byok-relay running is via Vercel:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay&env=ENCRYPTION_SECRET,ALLOWED_ORIGINS,APP_SECRET&envDescription=ENCRYPTION_SECRET%3A%20generate%20with%20%60openssl%20rand%20-hex%2032%60.%20ALLOWED_ORIGINS%3A%20your%20frontend%20domain%20(e.g.%20https%3A%2F%2Fmy-app.vercel.app)&envLink=https%3A%2F%2Fgithub.com%2Favikalpg%2Fbyok-relay%23setup&project-name=byok-relay&repository-name=byok-relay)

1. Click the button above
2. Set `ENCRYPTION_SECRET` (generate: `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (your frontend domain)
3. Deploy — your relay is live at `https://byok-relay-<hash>.vercel.app`

> **Note:** Vercel's serverless environment has an ephemeral filesystem, so SQLite state resets between cold starts. This is fine for demos and prototyping. For production with persistent key storage, deploy to a long-running server (see [Production setup](#production-ubuntu--systemd) below, or use Railway/Render).

## Setup

### 1. Install
```bash
git clone https://github.com/avikalpg/byok-relay.git
cd byok-relay
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Set ENCRYPTION_SECRET (generate: openssl rand -hex 32)
# Set ALLOWED_ORIGINS to your app's domain(s)
```

### 3. Run
```bash
npm start
```

### Production (Ubuntu + systemd)
```bash
# Copy service file
sudo cp deploy/byok-relay.service /etc/systemd/system/
sudo systemctl enable --now byok-relay

# HTTPS with nginx + Let's Encrypt
sudo apt install nginx
sudo snap install --classic certbot
sudo certbot --nginx -d relay.yourdomain.com
```

## Security

- **AES-256-GCM encryption** — keys are encrypted at rest; the `ENCRYPTION_SECRET` lives only in your server environment
- **Keys never returned** — after the initial POST, the key value is never sent over the wire again
- **Registration gate** — set `APP_SECRET` to require `Authorization: Bearer <secret>` on `POST /users`; without it anyone who reaches your relay can register. Generate with `openssl rand -hex 32`.
- **Rate limiting** — 100 req/min global, 20 AI req/min per token, 10 registrations/hour per IP
- **Startup validation** — server refuses to start without a valid `ENCRYPTION_SECRET`
- **CORS** — restrict `ALLOWED_ORIGINS` to your app's domain in production
- **HTTPS required** in production (mixed-content browsers block HTTP endpoints called from HTTPS pages)

## BYOK — your users pay for what they use

Two patterns, one integration:

**Prosumer / individual** — each user registers their own API key once. They use their own credits; you spend $0 on inference. Great for developer tools, research UIs, or any product where users already have API accounts.

**Team / B2B** — a company admin registers the org's shared API key once. The relay token lives in your app's backend; all team members access AI through your app, which routes requests automatically. Billing, usage, and key rotation are managed inside the customer's organisation — not by you.

byok-relay handles both patterns today.

## Trade-offs

- **You hold the encrypted keys** — users trust your server. Mitigate with a cloud KMS-backed store for higher assurance.
- **No built-in user accounts** — the relay token is the only credential. Scope tokens to IP or add your own auth layer for production.
- **Self-hosted** — you're responsible for uptime, security updates, and backups. Or use [relay.byokrelay.com](https://relay.byokrelay.com) and skip all of that.

## Find us on

- [There's An AI For That](https://theresanaiforthat.com) — *submission in review*
- [skills.sh](https://skills.sh/avikalpg/byok-relay) — AI coding agent skill registry
- [Awesome LLMOps](https://github.com/tensorchord/Awesome-LLMOps) — *PR in review*
- [Awesome ChatGPT API](https://github.com/reorx/awesome-chatgpt-api) — *PR in review*

## License

Apache 2.0

---

**Ready to integrate?** → Use `npx skills add avikalpg/byok-relay` or point your coding agent at [byokrelay.com/skill](https://byokrelay.com/skill)
