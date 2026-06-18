# byok-relay — Platform Integrations

Copy-paste integration guides for the most popular AI app builders and deployment platforms. Each guide gets you from zero to a working BYOK AI feature in under 10 minutes.

**Hosted relay** (no setup): `https://relay.byokrelay.com`

---

## Table of Contents

- [Lovable](#lovable)
- [Bolt.new](#boltnew)
- [Framer](#framer)
- [Vercel (Next.js)](#vercel-nextjs)
- [Plain React / Vite](#plain-react--vite)
- [Shared utilities](#shared-utilities)

---

## Lovable

Lovable generates React apps backed by Supabase. You can wire byok-relay into any Lovable project — no extra backend needed.

### Step 1 — Add the relay client

In Lovable's file editor, create `src/lib/relay.ts`:

```typescript
// src/lib/relay.ts
const RELAY_URL = 'https://relay.byokrelay.com';
const TOKEN_KEY = 'byok_relay_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export async function ensureToken(appId = 'my-lovable-app'): Promise<string> {
  const existing = getToken();
  if (existing) return existing;

  const res = await fetch(`${RELAY_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  const { token } = await res.json();
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

export async function storeKey(provider: string, apiKey: string): Promise<void> {
  const token = await ensureToken();
  const res = await fetch(`${RELAY_URL}/keys/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
    body: JSON.stringify({ key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Failed to store key: ${res.status}`);
  }
}

export async function listKeys(): Promise<string[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetch(`${RELAY_URL}/keys`, { headers: { 'x-relay-token': token } });
  if (!res.ok) return [];
  return res.json();
}

export async function streamChat(opts: {
  provider: 'openai' | 'anthropic';
  model: string;
  messages: Array<{ role: string; content: string }>;
  onChunk: (text: string) => void;
}): Promise<string> {
  const { provider, model, messages, onChunk } = opts;
  const token = await ensureToken();

  const isAnthropic = provider === 'anthropic';
  const url = isAnthropic
    ? `${RELAY_URL}/relay/anthropic/v1/messages`
    : `${RELAY_URL}/relay/openai/v1/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-relay-token': token,
    ...(isAnthropic ? { 'anthropic-version': '2023-06-01' } : {}),
  };

  const body = isAnthropic
    ? JSON.stringify({ model, max_tokens: 1024, stream: true, messages })
    : JSON.stringify({ model, stream: true, messages });

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Relay error: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const chunk =
          json.delta?.text ??
          json.choices?.[0]?.delta?.content ??
          '';
        if (chunk) { fullText += chunk; onChunk(chunk); }
      } catch { /* skip malformed SSE */ }
    }
  }
  return fullText;
}
```

### Step 2 — Add the API key settings component

Create `src/components/ApiKeySettings.tsx`:

```tsx
// src/components/ApiKeySettings.tsx
import { useState, useEffect } from 'react';
import { storeKey, listKeys } from '@/lib/relay';

export function ApiKeySettings() {
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [saved, setSaved] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    listKeys().then(setSaved);
  }, []);

  const handleSave = async () => {
    setStatus('Saving…');
    try {
      await storeKey(provider, key);
      setKey('');
      setSaved(await listKeys());
      setStatus('✅ Key saved');
    } catch (e: unknown) {
      setStatus(`❌ ${e instanceof Error ? e.message : 'Error'}`);
    }
  };

  return (
    <div className="space-y-3 p-4 border rounded-lg">
      <h3 className="font-semibold text-sm">Your AI Keys</h3>
      {saved.length > 0 && (
        <p className="text-xs text-green-600">Connected: {saved.join(', ')}</p>
      )}
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as 'openai' | 'anthropic')}
        className="w-full border rounded px-2 py-1 text-sm"
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input
        type="password"
        placeholder={provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="w-full border rounded px-2 py-1 text-sm"
      />
      <button
        onClick={handleSave}
        disabled={!key}
        className="w-full bg-blue-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
      >
        Save Key
      </button>
      {status && <p className="text-xs text-gray-500">{status}</p>}
    </div>
  );
}
```

### Step 3 — Use in your chat component

```tsx
import { streamChat } from '@/lib/relay';

const [response, setResponse] = useState('');

const handleAsk = async (question: string) => {
  setResponse('');
  await streamChat({
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: question }],
    onChunk: (chunk) => setResponse((prev) => prev + chunk),
  });
};
```

> **Prompt for Lovable:** *"Read the byok-relay skill at https://byokrelay.com/skill and add a BYOK AI feature to this app using the hosted relay at https://relay.byokrelay.com. Add an API key settings panel and a streaming chat component."*

---

## Bolt.new

Bolt runs a full Node.js + Vite environment in StackBlitz WebContainers. byok-relay's managed relay works directly from browser code — no server-side setup needed.

### One-prompt approach

Paste this into Bolt's prompt:

```
Read https://byokrelay.com/skill and integrate byok-relay into this project.
Use the managed relay at https://relay.byokrelay.com (no self-hosting needed).
Add:
1. A relay.js utility module (localStorage token, storeKey, streamChat)
2. An ApiKeyInput component (password field + save button, shows ✅ when saved)
3. Wire the chat or generation feature to use streamChat() from relay.js
```

### Manual setup

Create `src/relay.js` with the same content as the [Shared utilities](#shared-utilities) section below, then wire it into your components:

```javascript
// In any Bolt component
import { streamChat, storeKey, listKeys } from './relay.js';

// Show key input if no keys stored yet
const keys = await listKeys();
if (keys.length === 0) {
  // render <ApiKeyInput onSave={(k) => storeKey('openai', k)} />
}

// Stream a response
await streamChat({
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: userMessage }],
  onChunk: (text) => setOutput((p) => p + text),
});
```

### Environment variable (optional)

If you self-host the relay, set in Bolt's environment panel:

```
VITE_RELAY_URL=https://your-relay.example.com
```

---

## Framer

Framer supports custom React components and code overrides. byok-relay drops in as a code component.

### Step 1 — Create a Code Component

In Framer, go to **Assets → Code → New component**. Name it `AIChatBox`.

```tsx
// AIChatBox — Framer Code Component
import { useState } from "react"
import { addPropertyControls, ControlType } from "framer"

const RELAY_URL = "https://relay.byokrelay.com"
const TOKEN_KEY = "byok_relay_token"

async function ensureToken() {
  const t = localStorage.getItem(TOKEN_KEY)
  if (t) return t
  const res = await fetch(`${RELAY_URL}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: "framer-site" }),
  })
  const { token } = await res.json()
  localStorage.setItem(TOKEN_KEY, token)
  return token
}

export default function AIChatBox({ placeholder, accentColor }) {
  const [input, setInput] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [keySaved, setKeySaved] = useState(!!localStorage.getItem(TOKEN_KEY))
  const [output, setOutput] = useState("")
  const [loading, setLoading] = useState(false)

  const saveKey = async () => {
    const token = await ensureToken()
    await fetch(`${RELAY_URL}/keys/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-token": token },
      body: JSON.stringify({ key: apiKey }),
    })
    setKeySaved(true)
    setApiKey("")
  }

  const ask = async () => {
    if (!input || loading) return
    setLoading(true)
    setOutput("")
    const token = await ensureToken()
    const res = await fetch(`${RELAY_URL}/relay/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-token": token },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: input }],
      }),
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue
        const d = line.slice(6).trim()
        if (d === "[DONE]") continue
        try {
          const chunk = JSON.parse(d).choices?.[0]?.delta?.content ?? ""
          if (chunk) setOutput((p) => p + chunk)
        } catch {}
      }
      buf = buf.split("\n").pop()
    }
    setLoading(false)
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      {!keySaved && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            placeholder="Paste your OpenAI key (sk-...)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ flex: 1, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          />
          <button
            onClick={saveKey}
            style={{ background: accentColor, color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 }}
          >
            Save
          </button>
        </div>
      )}
      {keySaved && <p style={{ fontSize: 12, color: "#22c55e" }}>✅ Key connected</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          style={{ flex: 1, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
        />
        <button
          onClick={ask}
          disabled={loading || !keySaved}
          style={{ background: accentColor, color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13, opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "…" : "Ask"}
        </button>
      </div>
      {output && (
        <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: 10, fontSize: 13, lineHeight: 1.5 }}>
          {output}
        </div>
      )}
    </div>
  )
}

AIChatBox.defaultProps = {
  placeholder: "Ask anything…",
  accentColor: "#6366f1",
}

addPropertyControls(AIChatBox, {
  placeholder: { type: ControlType.String, title: "Placeholder" },
  accentColor: { type: ControlType.Color, title: "Accent color" },
})
```

### Step 2 — Drag onto canvas

Once the component compiles, drag `AIChatBox` onto your Framer canvas. Users enter their OpenAI key once; subsequent visits use the stored relay token.

> **Note:** For production Framer sites, consider wrapping key entry behind a toggle/modal so the key input is hidden by default.

---

## Vercel (Next.js)

If you have a Next.js app on Vercel, you can call byok-relay directly from client components — no API routes needed.

### App Router (Next.js 13+)

Create `lib/relay.ts` at the root of your project (same content as [Shared utilities](#shared-utilities) below, but with `'use client'`-compatible imports).

```typescript
// lib/relay.ts  (runs in browser only — do not import from Server Components)
const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? 'https://relay.byokrelay.com';
// ... (same implementation as Shared utilities)
```

Set in `.env.local` (or Vercel dashboard → Settings → Environment Variables):

```bash
NEXT_PUBLIC_RELAY_URL=https://relay.byokrelay.com
```

### Client component example

```tsx
// app/components/AiChat.tsx
'use client';

import { useState } from 'react';
import { streamChat, storeKey, listKeys } from '@/lib/relay';

export function AiChat() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyStored, setKeyStored] = useState(false);

  const handleSaveKey = async () => {
    await storeKey('openai', apiKey);
    setApiKey('');
    setKeyStored(true);
  };

  const handleAsk = async () => {
    setResponse('');
    await streamChat({
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      onChunk: (chunk) => setResponse((prev) => prev + chunk),
    });
  };

  return (
    <div className="space-y-4">
      {!keyStored && (
        <div className="flex gap-2">
          <input
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="flex-1 border rounded px-3 py-2 text-sm"
          />
          <button onClick={handleSaveKey} className="bg-black text-white px-4 py-2 rounded text-sm">
            Save key
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          placeholder="Ask anything…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          className="flex-1 border rounded px-3 py-2 text-sm"
        />
        <button onClick={handleAsk} className="bg-black text-white px-4 py-2 rounded text-sm">
          Ask
        </button>
      </div>
      {response && (
        <div className="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">{response}</div>
      )}
    </div>
  );
}
```

### Pages Router (Next.js 12 / legacy)

```tsx
// pages/index.tsx  (or any page)
import { AiChat } from '../components/AiChat';

export default function Home() {
  return (
    <main>
      <h1>My AI App</h1>
      <AiChat />
    </main>
  );
}
```

### Self-host the relay on Vercel

> ⚠️ **SQLite is not suitable on Vercel** (ephemeral filesystem — data is lost between function cold-starts).
> For production deployments, use Railway, Fly.io, or any VPS instead.
> The [managed relay](https://relay.byokrelay.com) is the easiest option for Vercel-hosted frontends.

If you want to self-host on Vercel with persistence, use [Turso](https://turso.tech) for a SQLite-compatible edge database. Open an issue on the byok-relay repo to request Turso/libSQL adapter support.

---

## Plain React / Vite

No platform-specific setup. Add `relay.js` and you're done.

```bash
# Vite project
npm create vite@latest my-app -- --template react
cd my-app
# copy relay.js from examples/react-vite/src/relay.js
cp node_modules/byok-relay/examples/... # or paste directly
```

Or use the npm client package:

```bash
npm install @byok-relay/client
```

```javascript
import { createClient } from '@byok-relay/client';

const relay = createClient({ relayUrl: 'https://relay.byokrelay.com', appId: 'my-app' });

// Store key
await relay.storeKey('openai', userApiKey);

// Stream chat
await relay.streamChat({
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
  onChunk: (text) => console.log(text),
});
```

---

## Shared utilities

Vanilla JS module that works in any browser environment. Copy this into your project as `relay.js`:

```javascript
// relay.js — byok-relay browser client
// Works in: React, Vue, Svelte, plain HTML, browser extensions, Electron
const RELAY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_URL)
  || (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_RELAY_URL)
  || 'https://relay.byokrelay.com';

const TOKEN_KEY = 'byok_relay_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export async function ensureToken(appId = 'my-app') {
  const existing = getToken();
  if (existing) return existing;
  const res = await fetch(`${RELAY_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  const { token } = await res.json();
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

export async function storeKey(provider, apiKey) {
  const token = await ensureToken();
  const res = await fetch(`${RELAY_URL}/keys/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
    body: JSON.stringify({ key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to store key: ${res.status}`);
  }
}

export async function listKeys() {
  const token = getToken();
  if (!token) return [];
  const res = await fetch(`${RELAY_URL}/keys`, { headers: { 'x-relay-token': token } });
  if (!res.ok) return [];
  return res.json();
}

export async function streamChat({ provider, model, messages, onChunk }) {
  const token = await ensureToken();
  const isAnthropic = provider === 'anthropic';
  const url = isAnthropic
    ? `${RELAY_URL}/relay/anthropic/v1/messages`
    : `${RELAY_URL}/relay/openai/v1/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'x-relay-token': token,
    ...(isAnthropic ? { 'anthropic-version': '2023-06-01' } : {}),
  };
  const body = isAnthropic
    ? JSON.stringify({ model, max_tokens: 1024, stream: true, messages })
    : JSON.stringify({ model, stream: true, messages });

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Relay error: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const chunk = json.delta?.text ?? json.choices?.[0]?.delta?.content ?? '';
        if (chunk) { fullText += chunk; onChunk?.(chunk); }
      } catch { /* skip */ }
    }
  }
  return fullText;
}
```

---

## Verify your setup

Run this smoke test in your browser console or Node.js to confirm everything is working:

```javascript
const RELAY = 'https://relay.byokrelay.com';

// 1. Health check
const health = await fetch(`${RELAY}/health`).then(r => r.json());
console.assert(health.status === 'ok', 'Health check failed', health);
console.log('✅ Relay healthy:', health.status);

// 2. Register a test user
const { token } = await fetch(`${RELAY}/users`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: 'smoke-test' }),
}).then(r => r.json());
console.log('✅ Token issued:', token.slice(0, 12) + '…');

// 3. List providers (should be empty for a fresh user)
const keys = await fetch(`${RELAY}/keys`, {
  headers: { 'x-relay-token': token },
}).then(r => r.json());
console.log('✅ Keys endpoint reachable, stored providers:', keys);
```

---

## Need help?

- **GitHub issues:** https://github.com/avikalpg/byok-relay/issues
- **Skill file (for AI agents):** https://byokrelay.com/skill
- **Full API reference:** See `README.md` in the repo
