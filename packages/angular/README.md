# @byok-relay/angular

Angular injectable services for [byok-relay](https://byokrelay.com) — drop-in BYOK AI in any Angular or Analog app.

```bash
npm install @byok-relay/angular
```

Four services, zero backend required. Your users bring their own OpenAI / Anthropic / Groq keys; byok-relay encrypts and stores them; you forward AI requests through the relay.

---

## Quick start (Angular 14+)

### 1. Set up providers (app.config.ts)

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideByokRelay } from '@byok-relay/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    // Uses the managed relay at https://relay.byokrelay.com by default.
    // For production, self-host byok-relay and pass your own URL.
    provideByokRelay({ relayUrl: 'https://relay.byokrelay.com' }),
  ],
};
```

### 2. Inject and use

```typescript
import { Component, inject, OnInit } from '@angular/core';
import { ByokRelayService, ChatService } from '@byok-relay/angular';

@Component({
  selector: 'app-chat',
  standalone: true,
  template: `
    <input [(ngModel)]="apiKey" placeholder="Your OpenAI API key" type="password" />
    <button (click)="saveKey()">Save key</button>

    <input [(ngModel)]="message" placeholder="Ask anything…" />
    <button (click)="send()" [disabled]="chat.loading()">Send</button>

    <div *ngFor="let m of chat.messages()">
      <strong>{{ m.role }}</strong>: {{ m.content }}
    </div>
  `,
})
export class ChatComponent implements OnInit {
  relay = inject(ByokRelayService);
  chat  = inject(ChatService);

  apiKey  = '';
  message = '';

  async ngOnInit() {
    await this.relay.getOrRegister('my-angular-app');
  }

  async saveKey() {
    await this.relay.storeKey('openai', this.apiKey);
    this.apiKey = '';
  }

  async send() {
    await this.chat.sendMessage(this.message);
    this.message = '';
  }
}
```

---

## Services

### `ByokRelayService` — token & key management

```typescript
const relay = inject(ByokRelayService);

// Register (or return existing token from localStorage)
await relay.getOrRegister('my-app');

// Store a provider key
await relay.storeKey('openai', 'sk-...');
await relay.storeKey('anthropic', 'sk-ant-...');
await relay.storeKey('groq', 'gsk_...');

// List stored providers
const { keys } = await relay.listKeys(); // ['openai', 'anthropic']

// Delete a key
await relay.deleteKey('anthropic');

// Atomic key rotation (verify new key → replace old key)
await relay.rotateKey('openai', 'sk-new-...');

// Reactive signals (Angular 16+ or plain function shim)
relay.token()    // current relay token or null
relay.loading()  // true while a request is in flight
relay.error()    // last error message or null

// Clear everything (logout)
relay.logout();
```

### `ChatService` — stateful non-streaming chat

```typescript
const chat = inject(ChatService);

await chat.sendMessage('What is BYOK?', {
  provider: 'openai',        // openai | anthropic | groq | mistral | openrouter
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant.',
});

chat.messages()  // [{ role: 'user', content: '…' }, { role: 'assistant', content: '…' }]
chat.loading()   // true while request is in flight
chat.error()     // last error or null
chat.clearMessages();
```

### `StreamingChatService` — SSE streaming with AbortController

```typescript
const streaming = inject(StreamingChatService);

await streaming.streamMessage('Tell me a story', {
  provider: 'openai',
  model: 'gpt-4o',
  onChunk: (delta, full) => console.log(delta), // live token callback
});

streaming.streamingContent()  // live partial text while streaming
streaming.streaming()         // true while SSE is open
streaming.messages()          // committed history (updated on completion)
streaming.stopStreaming();     // cancel mid-flight (partial response committed)
```

**Template binding example:**

```html
<div *ngIf="streaming.streaming()">
  {{ streaming.streamingContent() }}
</div>
<div *ngFor="let m of streaming.messages()">
  <strong>{{ m.role }}</strong>: {{ m.content }}
</div>
<button (click)="streaming.stopStreaming()">Stop</button>
```

### `RelayHealthService` — relay health polling

```typescript
const health = inject(RelayHealthService);

// One-shot check
await health.check();

// Deep check (pings upstream provider)
await health.check(true);

// Auto-poll (every 30 s by default)
health.startPolling();

// Angular lifecycle — stop the interval
ngOnDestroy() { health.destroy(); }

health.status()    // { status: 'ok', uptime: … } or null
health.isHealthy   // boolean shorthand
health.loading()
health.error()
```

---

## Angular signals (Angular 16+)

When `@angular/core` 16+ is present, all service state uses Angular's native `signal()` for automatic change detection in OnPush components:

```typescript
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span>{{ relay.token() }}</span>
    <span *ngIf="chat.loading()">Thinking…</span>
  `,
})
export class MyComponent {
  relay = inject(ByokRelayService);
  chat  = inject(ChatService);
}
```

Without Angular 16+, the services fall back to a plain getter shim that reads the same way but doesn't drive change detection automatically — call `markForCheck()` or switch to default change detection.

---

## Providers

| Provider | `provider` value | Models |
|---|---|---|
| OpenAI | `openai` | gpt-4o, gpt-4o-mini, o3, … |
| Anthropic | `anthropic` | claude-opus-4, claude-sonnet-4-5, … |
| Groq | `groq` | llama3-70b, mixtral-8x7b, … |
| Mistral | `mistral` | mistral-large, codestral, … |
| OpenRouter | `openrouter` | any model via openrouter.ai |
| Google | `google` | gemini-2.5-pro, gemini-2.0-flash, … |

---

## Standalone usage (without Angular DI)

The services are plain JS classes — use them anywhere:

```javascript
const { createByokRelayBundle } = require('@byok-relay/angular');

const { relayService, chatService, streamingChatService, healthService } =
  createByokRelayBundle({ relayUrl: 'https://relay.byokrelay.com' });

await relayService.register('my-app');
await relayService.storeKey('openai', 'sk-…');
const reply = await chatService.sendMessage('Hello!');
```

---

## Analog (SolidStart-inspired meta-framework)

Analog is Angular's full-stack meta-framework. The services are SSR-safe:

```typescript
// src/app/app.config.ts
import { provideByokRelay } from '@byok-relay/angular';

export const appConfig = {
  providers: [
    provideByokRelay({ relayUrl: process.env['RELAY_URL'] }),
  ],
};
```

`ByokRelayService` uses `localStorage` on the browser and falls back to an in-memory store during SSR — so token/key state is re-hydrated from localStorage on the client side.

---

## Self-hosting

For production apps, self-host byok-relay so user API keys never transit third-party infrastructure:

```bash
docker compose up -d
# relay now runs at http://localhost:3000
```

```typescript
provideByokRelay({ relayUrl: 'https://your-relay.example.com' })
```

See the [byok-relay README](https://github.com/avikalpg/byok-relay) for full self-hosting instructions.

---

## Related packages

| Package | Framework |
|---|---|
| [`@byok-relay/react`](https://www.npmjs.com/package/@byok-relay/react) | React hooks |
| [`@byok-relay/vue`](https://www.npmjs.com/package/@byok-relay/vue) | Vue 3 composables |
| [`@byok-relay/svelte`](https://www.npmjs.com/package/@byok-relay/svelte) | Svelte stores |
| [`@byok-relay/solid`](https://www.npmjs.com/package/@byok-relay/solid) | SolidJS stores |
| [`@byok-relay/mcp`](https://www.npmjs.com/package/@byok-relay/mcp) | Claude Desktop MCP server |
| [`@byok-relay/client`](https://www.npmjs.com/package/@byok-relay/client) | Vanilla JS client |

---

If this package saved you time, consider ⭐ [starring the repo](https://github.com/avikalpg/byok-relay).
