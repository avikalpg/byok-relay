/**
 * @byok-relay/angular
 *
 * Angular injectable services for byok-relay — drop-in BYOK AI in any Angular or Analog app.
 *
 * Usage:
 *   import {
 *     ByokRelayService,
 *     ChatService,
 *     StreamingChatService,
 *     RelayHealthService,
 *     provideByokRelay,
 *   } from '@byok-relay/angular';
 *
 * No build step required. @angular/core peer dep optional — services work as plain JS classes too.
 * For Analog SSR: services are server-safe (localStorage guarded by isPlatformBrowser checks).
 *
 * Angular 14+: use inject() API.
 * Angular 16+: reactive signals via Angular's signal() when available; plain getters otherwise.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';
const DEFAULT_STORAGE_KEY = 'byok_relay_token';

const PROVIDER_PATHS = {
  openai:     'chat/completions',
  anthropic:  'messages',
  groq:       'chat/completions',
  mistral:    'chat/completions',
  openrouter: 'chat/completions',
};

// ─── Angular signal shim ─────────────────────────────────────────────────────

/**
 * Create an Angular-compatible reactive signal.
 * When @angular/core 16+ is available, uses Angular's signal() for change detection.
 * Falls back to a plain getter/setter pair that still works outside Angular contexts.
 *
 * Returns { value: getter, set, update } — mirrors Angular's WritableSignal contract.
 */
function createAngularSignal(initial) {
  // Use native Angular signals when available (Angular 16+)
  try {
    const core = require('@angular/core');
    if (typeof core.signal === 'function') {
      const sig = core.signal(initial);
      return {
        value: sig,          // callable getter: sig()
        set: (v) => sig.set(v),
        update: (fn) => sig.update(fn),
      };
    }
  } catch { /* @angular/core not installed */ }

  // Plain shim — getter function + set/update
  let _value = initial;
  const getter = () => _value;
  return {
    value: getter,
    set: (v) => { _value = v; },
    update: (fn) => { _value = fn(_value); },
  };
}

// ─── Storage helper ──────────────────────────────────────────────────────────

function getSafeStorage() {
  try {
    // SSR-safe: localStorage may not exist on the server
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* ignore */ }
  // In-memory fallback (Angular Universal / Analog SSR)
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

function buildChatBody(provider, model, messages, systemPrompt, extra = {}, stream = false) {
  const allMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [...messages];

  if (provider === 'anthropic') {
    const system = allMessages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const body = {
      model,
      messages: allMessages.filter((m) => m.role !== 'system'),
      max_tokens: 1024,
      ...(stream ? { stream: true } : {}),
      ...extra,
    };
    if (system) body.system = system;
    return body;
  }

  return {
    model,
    messages: allMessages,
    ...(stream ? { stream: true } : {}),
    ...extra,
  };
}

function extractStreamDelta(event, provider) {
  if (!event) return '';
  if (provider === 'anthropic') {
    if (event.type === 'content_block_delta') return event.delta?.text || '';
    return '';
  }
  return event.choices?.[0]?.delta?.content ?? '';
}

// ─── ByokRelayService ─────────────────────────────────────────────────────────

/**
 * Core BYOK relay service.
 * Manages relay token registration, key CRUD, and localStorage persistence.
 *
 * Angular DI usage:
 *   providers: [provideByokRelay({ relayUrl: 'https://relay.byokrelay.com' })]
 *
 * Standalone usage:
 *   const relay = new ByokRelayService({ relayUrl: '...' });
 */
class ByokRelayService {
  constructor(config = {}) {
    this._relayUrl = (config.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, '');
    this._storageKey = config.storageKey || DEFAULT_STORAGE_KEY;
    this._storage = config.storage || getSafeStorage();

    // Reactive signals
    this._token = createAngularSignal(this._storage.getItem(this._storageKey));
    this._loading = createAngularSignal(false);
    this._error = createAngularSignal(null);
  }

  // Signals (Angular 16+: call as functions; plain JS: call as functions via shim)
  get token() { return this._token.value; }
  get loading() { return this._loading.value; }
  get error() { return this._error.value; }
  get relayUrl() { return this._relayUrl; }

  /** Register a new relay user and persist the token. */
  async register(appId, options = {}) {
    this._loading.set(true);
    this._error.set(null);
    try {
      const body = { app_id: appId };
      if (options.appSecret) body.app_secret = options.appSecret;

      const resp = await fetch(`${this._relayUrl}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => String(resp.status));
        throw new Error(`Register failed (${resp.status}): ${msg}`);
      }
      const data = await resp.json();
      this._storage.setItem(this._storageKey, data.token);
      this._token.set(data.token);
      return data;
    } catch (err) {
      this._error.set(err.message);
      throw err;
    } finally {
      this._loading.set(false);
    }
  }

  /** Return stored token without re-registering, or register fresh if none. */
  async getOrRegister(appId, options = {}) {
    const stored = this._storage.getItem(this._storageKey);
    if (stored) {
      this._token.set(stored);
      return { token: stored };
    }
    return this.register(appId, options);
  }

  /** Store (or update) an API key for a given provider. */
  async storeKey(provider, apiKey) {
    const tok = this._storage.getItem(this._storageKey);
    if (!tok) throw new Error('Not registered. Call register() or getOrRegister() first.');
    const resp = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': tok },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!resp.ok) throw new Error(`Store key failed (${resp.status})`);
    return resp.json();
  }

  /** List all stored provider keys (names only, not values). */
  async listKeys() {
    const tok = this._storage.getItem(this._storageKey);
    if (!tok) throw new Error('Not registered.');
    const resp = await fetch(`${this._relayUrl}/keys`, {
      headers: { 'x-relay-token': tok },
    });
    if (!resp.ok) throw new Error(`List keys failed (${resp.status})`);
    return resp.json();
  }

  /** Delete a provider key. */
  async deleteKey(provider) {
    const tok = this._storage.getItem(this._storageKey);
    if (!tok) throw new Error('Not registered.');
    const resp = await fetch(`${this._relayUrl}/keys/${provider}`, {
      method: 'DELETE',
      headers: { 'x-relay-token': tok },
    });
    if (!resp.ok) throw new Error(`Delete key failed (${resp.status})`);
    return resp.json();
  }

  /** Atomically rotate (verify-then-replace) a provider key. */
  async rotateKey(provider, newApiKey) {
    const tok = this._storage.getItem(this._storageKey);
    if (!tok) throw new Error('Not registered.');
    const resp = await fetch(`${this._relayUrl}/keys/${provider}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-token': tok },
      body: JSON.stringify({ api_key: newApiKey }),
    });
    if (!resp.ok) throw new Error(`Rotate key failed (${resp.status})`);
    return resp.json();
  }

  /** Clear token from storage and reset state (logout). */
  logout() {
    this._storage.removeItem(this._storageKey);
    this._token.set(null);
    this._error.set(null);
  }

  /** Get relay stats for the current user. */
  async getStats(appId) {
    const tok = this._storage.getItem(this._storageKey);
    if (!tok) throw new Error('Not registered.');
    const url = appId
      ? `${this._relayUrl}/stats/${appId}`
      : `${this._relayUrl}/stats`;
    const resp = await fetch(url, { headers: { 'x-relay-token': tok } });
    if (!resp.ok) throw new Error(`Stats failed (${resp.status})`);
    return resp.json();
  }
}

// ─── ChatService ──────────────────────────────────────────────────────────────

/**
 * Non-streaming chat service with stateful message history.
 * Depends on ByokRelayService.
 *
 * Angular DI usage (inject):
 *   private relay = inject(ByokRelayService);
 *   private chat = inject(ChatService);
 *
 * Standalone:
 *   const chat = new ChatService(relayService);
 */
class ChatService {
  constructor(relayService) {
    if (!relayService) throw new Error('ChatService requires a ByokRelayService instance.');
    this._relay = relayService;

    this._messages = createAngularSignal([]);
    this._loading = createAngularSignal(false);
    this._error = createAngularSignal(null);
    this._activeRequests = 0;
    this._sendQueue = Promise.resolve();
  }

  get messages() { return this._messages.value; }
  get loading() { return this._loading.value; }
  get error() { return this._error.value; }

  /** Clear message history. */
  clearMessages() {
    this._messages.set([]);
    this._error.set(null);
  }

  /**
   * Send a user message, get a response, and append both to message history.
   * @param {string} content - The user message.
   * @param {object} options - { provider, model, systemPrompt, ...extraBody }
   */
  async sendMessage(content, options = {}) {
    const trimmedContent = content?.trim();
    if (!trimmedContent) throw new Error('Message content is required');

    const {
      provider = 'openai',
      model = 'gpt-4o-mini',
      systemPrompt,
      ...extra
    } = options;

    const tok = this._relay.token();
    if (!tok) throw new Error('Not registered. Call ByokRelayService.register() first.');

    this._activeRequests += 1;
    this._loading.set(true);

    const run = async () => {
      const newUserMsg = { role: 'user', content: trimmedContent };
      this._messages.update((prev) => [...prev, newUserMsg]);
      this._error.set(null);

      const history = this._messages.value();
      const body = buildChatBody(provider, model, history, systemPrompt, extra);

      try {
        const path = PROVIDER_PATHS[provider] || 'chat/completions';
        const resp = await fetch(
          `${this._relay.relayUrl}/relay/${provider}/${path}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-relay-token': tok },
            body: JSON.stringify(body),
          },
        );
        if (!resp.ok) {
          const msg = await resp.text().catch(() => String(resp.status));
          throw new Error(`Chat request failed (${resp.status}): ${msg}`);
        }
        const data = await resp.json();
        // OpenAI-compatible + Anthropic response shapes
        const reply =
          data.choices?.[0]?.message?.content ??
          data.content?.[0]?.text ??
          '';
        this._messages.update((prev) => [...prev, { role: 'assistant', content: reply }]);
        return reply;
      } catch (err) {
        // Roll back this request's user message on failure.
        this._messages.update((prev) => prev.filter((message) => message !== newUserMsg));
        this._error.set(err.message);
        throw err;
      }
    };

    const current = this._sendQueue.catch(() => undefined).then(run);
    this._sendQueue = current.catch(() => undefined);

    try {
      return await current;
    } finally {
      this._activeRequests = Math.max(0, this._activeRequests - 1);
      if (this._activeRequests === 0) this._loading.set(false);
    }
  }
}

// ─── StreamingChatService ────────────────────────────────────────────────────

/**
 * SSE streaming chat service with AbortController support.
 * Depends on ByokRelayService.
 *
 * Standalone:
 *   const streaming = new StreamingChatService(relayService);
 *   await streaming.streamMessage('Hello!', { onChunk: (delta) => console.log(delta) });
 *   streaming.stopStreaming(); // cancel mid-flight
 */
class StreamingChatService {
  constructor(relayService) {
    if (!relayService) throw new Error('StreamingChatService requires a ByokRelayService instance.');
    this._relay = relayService;
    this._abortController = null;

    this._messages = createAngularSignal([]);
    this._streamingContent = createAngularSignal('');
    this._streaming = createAngularSignal(false);
    this._error = createAngularSignal(null);
  }

  get messages() { return this._messages.value; }
  get streamingContent() { return this._streamingContent.value; }
  get streaming() { return this._streaming.value; }
  get error() { return this._error.value; }

  clearMessages() {
    this._messages.set([]);
    this._error.set(null);
  }

  /** Abort the current in-flight stream. Partial response is committed. */
  stopStreaming() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Stream a message via SSE. Appends to message history.
   * @param {string} content - The user message.
   * @param {object} options - { provider, model, systemPrompt, onChunk, ...extraBody }
   */
  async streamMessage(content, options = {}) {
    const trimmedContent = content?.trim();
    if (!trimmedContent) throw new Error('Message content is required');
    if (this._streaming.value()) throw new Error('A stream is already active');

    const {
      provider = 'openai',
      model = 'gpt-4o-mini',
      systemPrompt,
      onChunk,
      ...extra
    } = options;

    const tok = this._relay.token();
    if (!tok) throw new Error('Not registered. Call ByokRelayService.register() first.');

    const newUserMsg = { role: 'user', content: trimmedContent };
    this._messages.update((prev) => [...prev, newUserMsg]);
    this._streaming.set(true);
    this._streamingContent.set('');
    this._error.set(null);
    this._abortController = new AbortController();

    const history = this._messages.value();
    const body = buildChatBody(provider, model, history, systemPrompt, extra, true);

    let accumulated = '';

    try {
      const path = PROVIDER_PATHS[provider] || 'chat/completions';
      const resp = await fetch(
        `${this._relay.relayUrl}/relay/${provider}/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-relay-token': tok },
          body: JSON.stringify(body),
          signal: this._abortController.signal,
        },
      );
      if (!resp.ok) {
        const msg = await resp.text().catch(() => String(resp.status));
        throw new Error(`Stream request failed (${resp.status}): ${msg}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let leftover = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = leftover + decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = extractStreamDelta(parsed, provider);
            if (delta) {
              accumulated += delta;
              this._streamingContent.set(accumulated);
              if (onChunk) onChunk(delta, accumulated);
            }
          } catch { /* skip malformed SSE lines */ }
        }
        if (streamDone) break;
      }

      this._messages.update((prev) => [
        ...prev,
        { role: 'assistant', content: accumulated },
      ]);
      this._streamingContent.set('');
      return accumulated;
    } catch (err) {
      if (err.name === 'AbortError') {
        // Partial commit: save whatever was streamed
        if (accumulated) {
          this._messages.update((prev) => [
            ...prev,
            { role: 'assistant', content: accumulated + ' [stopped]' },
          ]);
        } else {
          // Nothing streamed — roll back this stream's user message.
          this._messages.update((prev) => prev.filter((message) => message !== newUserMsg));
        }
        this._streamingContent.set('');
      } else {
        this._messages.update((prev) => prev.filter((message) => message !== newUserMsg));
        this._error.set(err.message);
        this._streamingContent.set('');
        throw err;
      }
    } finally {
      this._streaming.set(false);
      this._abortController = null;
    }
  }
}

// ─── RelayHealthService ───────────────────────────────────────────────────────

/**
 * Polls the relay /health endpoint on a configurable interval.
 * Depends on ByokRelayService (for relayUrl).
 *
 * Angular lifecycle: call destroy() in ngOnDestroy to stop the poller.
 *
 * Standalone:
 *   const health = new RelayHealthService(relayService);
 *   health.startPolling();
 *   // later: health.destroy();
 */
class RelayHealthService {
  constructor(relayService, intervalMs = 30_000) {
    if (!relayService) throw new Error('RelayHealthService requires a ByokRelayService instance.');
    this._relay = relayService;
    this._intervalMs = intervalMs;
    this._intervalId = null;

    this._status = createAngularSignal(null);
    this._loading = createAngularSignal(false);
    this._error = createAngularSignal(null);
  }

  get status() { return this._status.value; }
  get loading() { return this._loading.value; }
  get error() { return this._error.value; }
  get isHealthy() {
    const s = this._status.value();
    return s != null && s.status === 'ok';
  }

  /**
   * Run a single health check.
   * @param {boolean} deep - Include upstream provider ping (GET /health?deep=1).
   */
  async check(deep = false) {
    this._loading.set(true);
    this._error.set(null);
    try {
      const url = deep
        ? `${this._relay.relayUrl}/health?deep=1`
        : `${this._relay.relayUrl}/health`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Health check returned ${resp.status}`);
      const data = await resp.json();
      this._status.set(data);
      return data;
    } catch (err) {
      this._error.set(err.message);
      throw err;
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Start polling at `intervalMs` cadence.
   * Runs an immediate check, then on the interval.
   */
  startPolling(intervalMs = this._intervalMs) {
    if (this._intervalId) return; // already polling
    this.check().catch(() => {}); // immediate, non-throwing
    this._intervalId = setInterval(() => this.check().catch(() => {}), intervalMs);
  }

  /** Stop the polling interval. */
  stopPolling() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /** Alias for stopPolling — call in ngOnDestroy to avoid memory leaks. */
  destroy() {
    this.stopPolling();
  }
}

// ─── Angular provider factory ─────────────────────────────────────────────────

/**
 * Create a pre-wired set of all four services.
 * For use in Angular providers array, standalone components, or plain JS.
 *
 * Angular (app.config.ts):
 *   export const appConfig: ApplicationConfig = {
 *     providers: [
 *       provideByokRelay({ relayUrl: 'https://relay.byokrelay.com' }),
 *     ],
 *   };
 *
 * Standalone component:
 *   const { relayService, chatService, streamingChatService, healthService } =
 *     createByokRelayBundle({ relayUrl: 'https://relay.byokrelay.com' });
 */
function createByokRelayBundle(config = {}) {
  const relayService = new ByokRelayService(config);
  const chatService = new ChatService(relayService);
  const streamingChatService = new StreamingChatService(relayService);
  const healthService = new RelayHealthService(relayService, config.healthIntervalMs);
  return { relayService, chatService, streamingChatService, healthService };
}

/**
 * Angular provider factory for use in providers arrays (Angular 14+).
 * Returns an Angular EnvironmentProviders-compatible object when @angular/core is installed,
 * or the raw service bundle when used outside Angular.
 *
 * @param {object} config - { relayUrl, storageKey, storage, healthIntervalMs }
 */
function provideByokRelay(config = {}) {
  try {
    const { makeEnvironmentProviders } = require('@angular/core');
    const providers = [
      {
        provide: ByokRelayService,
        useFactory: () => new ByokRelayService(config),
      },
      {
        provide: ChatService,
        useFactory: (r) => new ChatService(r),
        deps: [ByokRelayService],
      },
      {
        provide: StreamingChatService,
        useFactory: (r) => new StreamingChatService(r),
        deps: [ByokRelayService],
      },
      {
        provide: RelayHealthService,
        useFactory: (r) => new RelayHealthService(r, config.healthIntervalMs),
        deps: [ByokRelayService],
      },
    ];

    return typeof makeEnvironmentProviders === 'function'
      ? makeEnvironmentProviders(providers)
      : providers;
  } catch {
    // @angular/core not installed — return plain bundle (test / standalone usage)
    return createByokRelayBundle(config);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ByokRelayService,
  ChatService,
  StreamingChatService,
  RelayHealthService,
  createByokRelayBundle,
  provideByokRelay,
  DEFAULT_RELAY_URL,
  DEFAULT_STORAGE_KEY,
};
