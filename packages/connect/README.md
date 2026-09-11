# @byok-relay/connect

**Headless Connect AI state machine for [byok-relay](https://github.com/avikalpg/byok-relay).**

Manages the complete provider key connection lifecycle — provider selection, key input, live validation, connected/invalid/expired/rate-limited states, rotation, and disconnection — without owning any UI.

Framework packages (React, Vue, Svelte, etc.) wrap this same headless state machine so you get consistent credential UX across your whole stack.

```
idle → selecting → entering_key → connecting → connected
                                             ↓ invalid
                                             ↓ expired
                                             ↓ rate_limited
connected → rotating → connected
connected → disconnecting → idle
```

## Install

```bash
npm install @byok-relay/connect
```

## Quick start — vanilla JS

```js
import { createConnectController } from '@byok-relay/connect';

// 1. Obtain a relay token (one-time, store it)
const { token } = await fetch('https://relay.byokrelay.com/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: 'my-app' }),
}).then(r => r.json());

// 2. Create the controller
const ctrl = createConnectController({ token });

// 3. Subscribe to state changes and render
ctrl.subscribe(({ state, provider, connectedProviders, error, providers }) => {
  switch (state) {
    case 'idle':
      renderProviderList(providers, connectedProviders);
      break;
    case 'entering_key':
      renderKeyInput(provider, error);
      break;
    case 'connecting':
      renderSpinner('Validating key…');
      break;
    case 'connected':
      renderConnected(provider);
      break;
    case 'invalid':
      renderError(error.message);
      break;
    // … rate_limited, expired, rotating, disconnecting, error
  }
});

// 4. Refresh connected providers on load
await ctrl.refresh();

// 5. Drive the flow with actions
ctrl.selectProvider('openai');
await ctrl.connect('sk-…');     // validates format then calls relay
await ctrl.rotate('sk-new-…'); // live-pings new key before committing
await ctrl.disconnect();        // removes stored key
```

## Quick start — React

```tsx
import { useConnectAI } from '@byok-relay/connect/react';

function ConnectAIPanel({ token }) {
  const { state, provider, connectedProviders, providers, error, actions } =
    useConnectAI({ token });

  if (state === 'idle') {
    return (
      <ul>
        {providers.map(p => (
          <li key={p.id}>
            {p.name}{connectedProviders[p.id] ? ' ✓' : ''}
            <button onClick={() => actions.selectProvider(p.id)}>
              {connectedProviders[p.id] ? 'Manage' : 'Connect'}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  if (state === 'entering_key' || state === 'invalid') {
    return (
      <form onSubmit={async e => {
        e.preventDefault();
        const form = e.currentTarget;
        const key = (form.elements.namedItem('key') as HTMLInputElement).value;
        try {
          await actions.connect(key);
        } finally {
          form.reset();
        }
      }}>
        <input name="key" type="password" placeholder="Paste your API key…" autoComplete="off" />
        {error && <p style={{ color: 'red' }}>{error.message}</p>}
        <button type="submit">Connect</button>
        <button type="button" onClick={actions.clearProvider}>Cancel</button>
      </form>
    );
  }

  if (state === 'connecting' || state === 'rotating') return <p>Validating…</p>;

  if (state === 'connected') {
    return (
      <div>
        <p>{provider} connected ✓</p>
        <button onClick={() => actions.disconnect()}>Disconnect</button>
        <button onClick={() => {/* show rotation form */}}>Rotate key</button>
      </div>
    );
  }

  return null;
}
```

## API — `createConnectController(opts)`

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | **required** | Relay token from `POST /users` |
| `relayUrl` | `string` | `https://relay.byokrelay.com` | Relay base URL |
| `providers` | `object[]` | see below | Override the default provider list |
| `onStateChange` | `function` | — | Shorthand subscriber |

### Returns — `ConnectController`

| Member | Type | Description |
|--------|------|-------------|
| `getSnapshot()` | `() → Snapshot` | Current state snapshot (safe copy) |
| `subscribe(fn)` | `(fn) → unsubscribe` | Subscribe to state changes |
| `refresh()` | `async () → void` | Fetch connected providers from relay |
| `selectProvider(id)` | `(string) → void` | Move to `entering_key` |
| `clearProvider()` | `() → void` | Return to `idle` |
| `connect(key)` | `async (string) → void` | Validate format + store key at relay |
| `rotate(newKey, pid?)` | `async (string, string?) → void` | Rotate to a new key |
| `disconnect(pid?)` | `async (string?) → void` | Delete stored key |
| `cancel()` | `() → void` | Cancel in-flight op |
| `reset()` | `() → void` | Return to `idle`, clear everything |
| `providers` | `object[]` | The active provider list |
| `STATES` | `object` | All state name constants |

### `Snapshot` shape

```ts
{
  state:              string;     // current state name
  provider:           string | null; // selected provider id
  connectedProviders: Record<string, true>; // providers with a stored key
  error:              { message: string; code: string; status?: number } | null;
  providers:          ProviderMeta[]; // full provider list for rendering
}
```

### States

| State | Description |
|-------|-------------|
| `idle` | No provider selected |
| `selecting` | Provider list is visible (optional UI hint) |
| `entering_key` | Provider chosen; waiting for key input |
| `connecting` | POST /keys/:provider in flight |
| `connected` | Key stored and verified |
| `invalid` | Key rejected (format error or provider-side 401/403) |
| `expired` | Key revoked or expired (410) |
| `rate_limited` | Key hit provider rate limit (429) |
| `rotating` | POST /keys/:provider/rotate in flight |
| `disconnecting` | DELETE /keys/:provider in flight |
| `error` | Network error; old key untouched |

## API — `useConnectAI(opts)` (React)

```js
import { useConnectAI } from '@byok-relay/connect/react';
```

Same options as `createConnectController`. Returns all `Snapshot` fields plus:

| Field | Type | Description |
|-------|------|-------------|
| `actions.selectProvider` | `(id) → void` | |
| `actions.clearProvider` | `() → void` | |
| `actions.connect` | `async (key) → void` | |
| `actions.rotate` | `async (newKey, pid?) → void` | |
| `actions.disconnect` | `async (pid?) → void` | |
| `actions.cancel` | `() → void` | |
| `actions.reset` | `() → void` | |
| `actions.refresh` | `async () → void` | |

The hook re-creates the controller when `token` or `relayUrl` changes. `autoRefresh` (default `true`) fetches connected providers on mount.

## Default provider list

| Provider | Key pattern |
|----------|------------|
| OpenAI | `sk-…` |
| Anthropic | `sk-ant-…` |
| Google AI | `AIza…` |
| Groq | `gsk_…` |
| Mistral AI | alphanumeric |
| OpenRouter | `sk-or-v1-…` |
| ElevenLabs | alphanumeric |
| Hugging Face | `hf_…` |
| Deepgram | alphanumeric |

Pass a `providers` array to override this list. Each entry:

```ts
{
  id:          string;   // e.g. 'openai'
  name:        string;   // Display name
  keyHint:     string;   // Placeholder text
  keyPattern:  RegExp;   // Client-side format check
  docsUrl:     string;   // Link to API key creation page
  description: string;   // One-line description for UI
}
```

## Security

- Raw provider keys exist in memory only until the relay POST resolves, then become GC-eligible.
- Keys are **never** stored in `localStorage`, `sessionStorage`, or any controller field.
- No analytics capture occurs.
- Relay token storage follows your relay/app namespace rules.
- Live validation happens server-side: the relay verifies the key against the provider before storing it.

## Self-hosting

Set `relayUrl` to your self-hosted instance:

```js
createConnectController({ token, relayUrl: 'https://ai.myapp.com' });
```

## Related packages

| Package | Purpose |
|---------|---------|
| `@byok-relay/react` | React hooks (useByokRelay, useChat, useStreamingChat) |
| `@byok-relay/vue` | Vue composables |
| `@byok-relay/svelte` | Svelte stores |
| `@byok-relay/client` | Vanilla JS client (all relay methods) |
| `@byok-relay/mcp` | MCP server for Claude Desktop / Claude Code |

## License

MIT
