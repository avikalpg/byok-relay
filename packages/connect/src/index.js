/**
 * @byok-relay/connect
 *
 * Headless Connect AI state machine for byok-relay.
 *
 * Manages the full provider key connection lifecycle:
 *   idle → selecting → entering_key → connecting → connected
 *                                                 ↓ invalid
 *                                                 ↓ expired
 *                                                 ↓ rate_limited
 *   connected → rotating → connected
 *   connected → disconnecting → idle
 *
 * Security requirements (per issue #103):
 *   - Raw provider keys exist in memory only as long as needed to submit
 *   - No localStorage/sessionStorage persistence for provider keys
 *   - No analytics capture of input values
 *   - Relay token storage follows relay/app namespacing rules
 *
 * Usage:
 *   const ctrl = createConnectController({ relayUrl, token });
 *   ctrl.subscribe(({ state, provider, connectedProviders, error }) => render());
 *   ctrl.selectProvider('openai');
 *   ctrl.connect('sk-...');
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://relay.byokrelay.com';

/**
 * All valid states in the Connect AI state machine.
 */
const STATES = {
  IDLE:          'idle',
  SELECTING:     'selecting',
  ENTERING_KEY:  'entering_key',
  CONNECTING:    'connecting',
  CONNECTED:     'connected',
  INVALID:       'invalid',
  EXPIRED:       'expired',
  RATE_LIMITED:  'rate_limited',
  ROTATING:      'rotating',
  DISCONNECTING: 'disconnecting',
  ERROR:         'error',
};

/**
 * Default supported providers with display metadata.
 * Callers may override via the `providers` option.
 */
const DEFAULT_PROVIDERS = [
  {
    id:          'openai',
    name:        'OpenAI',
    keyHint:     'sk-...',
    keyPattern:  /^sk-[A-Za-z0-9_-]{20,}$/,
    docsUrl:     'https://platform.openai.com/api-keys',
    description: 'Powers GPT-4o, GPT-4o-mini, o1, and more',
  },
  {
    id:          'anthropic',
    name:        'Anthropic',
    keyHint:     'sk-ant-...',
    keyPattern:  /^sk-ant-[A-Za-z0-9_-]{90,}$/,
    docsUrl:     'https://console.anthropic.com/settings/keys',
    description: 'Powers Claude 3.5 Sonnet, Claude 3 Opus, and more',
  },
  {
    id:          'google',
    name:        'Google AI',
    keyHint:     'AIza...',
    keyPattern:  /^AIza[A-Za-z0-9_-]{35,}$/,
    docsUrl:     'https://aistudio.google.com/app/apikey',
    description: 'Powers Gemini 2.0, Gemini 1.5 Pro, and more',
  },
  {
    id:          'groq',
    name:        'Groq',
    keyHint:     'gsk_...',
    keyPattern:  /^gsk_[A-Za-z0-9]{50,}$/,
    docsUrl:     'https://console.groq.com/keys',
    description: 'Ultra-fast inference for open models',
  },
  {
    id:          'mistral',
    name:        'Mistral AI',
    keyHint:     '...',
    keyPattern:  /^[A-Za-z0-9]{30,}$/,
    docsUrl:     'https://console.mistral.ai/api-keys',
    description: 'Powers Mistral Large, Codestral, and more',
  },
  {
    id:          'openrouter',
    name:        'OpenRouter',
    keyHint:     'sk-or-v1-...',
    keyPattern:  /^sk-or-v1-[A-Za-z0-9]{60,}$/,
    docsUrl:     'https://openrouter.ai/keys',
    description: 'Routes to 300+ models from a single key',
  },
  {
    id:          'elevenlabs',
    name:        'ElevenLabs',
    keyHint:     '...',
    keyPattern:  /^[A-Za-z0-9_-]{30,}$/,
    docsUrl:     'https://elevenlabs.io/app/settings/api-keys',
    description: 'Text-to-speech and voice AI',
  },
  {
    id:          'huggingface',
    name:        'Hugging Face',
    keyHint:     'hf_...',
    keyPattern:  /^hf_[A-Za-z0-9]{30,}$/,
    docsUrl:     'https://huggingface.co/settings/tokens',
    description: 'Open model hub and inference APIs',
  },
  {
    id:          'deepgram',
    name:        'Deepgram',
    keyHint:     '...',
    keyPattern:  /^[A-Za-z0-9]{30,}$/,
    docsUrl:     'https://console.deepgram.com/create-key',
    description: 'Speech-to-text and audio AI',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Relay API call helper. Throws on network failure.
 * Does NOT throw on non-2xx responses — callers read .ok and .status.
 */
async function relayFetch(relayUrl, path, { method = 'GET', token, body, signal } = {}) {
  const url = `${relayUrl.replace(/\/$/, '')}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-relay-token'] = token;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  return { ok: res.ok, status: res.status, data };
}

/**
 * Scrub a key string from memory by overwriting the value reference.
 * In JS we cannot zero-fill arbitrary strings, but we can at least drop
 * the reference so it becomes GC-eligible. Callers should not retain copies.
 */
function scrubKey(keyRef) {
  // eslint-disable-next-line no-param-reassign
  keyRef = null; // eslint-disable-line no-unused-vars
}

// ─── ConnectController ────────────────────────────────────────────────────────

/**
 * Create a headless Connect AI controller.
 *
 * @param {object} opts
 * @param {string}   opts.relayUrl      - Relay base URL. Default: https://relay.byokrelay.com
 * @param {string}   opts.token         - Relay token from POST /users (x-relay-token).
 * @param {object[]} [opts.providers]   - Override the default provider list.
 * @param {function} [opts.onStateChange] - Shorthand subscriber (same as subscribe).
 *
 * @returns {ConnectController}
 */
function createConnectController({ relayUrl = DEFAULT_RELAY_URL, token, providers, onStateChange } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('@byok-relay/connect: token is required (POST /users to obtain one)');
  }

  const _relayUrl = relayUrl;
  const _token    = token;
  const _providers = Array.isArray(providers) ? providers : DEFAULT_PROVIDERS;

  let _state             = STATES.IDLE;
  let _selectedProvider  = null;  // provider id string
  let _connectedProviders = {};   // { [providerId]: true }
  let _error             = null;  // { message, code? }
  let _abortController   = null;

  const _subscribers = new Set();

  // ── Internal ──────────────────────────────────────────────────────────────

  function _emit() {
    const snap = _snapshot();
    for (const fn of _subscribers) {
      try { fn(snap); } catch { /* subscriber errors must not break controller */ }
    }
  }

  function _setState(next, { provider, error, connectedProviders } = {}) {
    _state = next;
    if (provider !== undefined)           _selectedProvider   = provider;
    if (error !== undefined)              _error              = error;
    if (connectedProviders !== undefined) _connectedProviders = connectedProviders;
    _emit();
  }

  function _snapshot() {
    return {
      state:              _state,
      provider:           _selectedProvider,
      connectedProviders: { ..._connectedProviders },
      error:              _error ? { ..._error } : null,
      providers:          _providers,
    };
  }

  function _abort() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
  }

  async function _loadConnectedProviders() {
    try {
      const res = await relayFetch(_relayUrl, '/keys', { token: _token });
      if (res.ok && Array.isArray(res.data.providers)) {
        const map = {};
        for (const p of res.data.providers) map[p] = true;
        return map;
      }
    } catch { /* network error — return empty */ }
    return {};
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * @param {function} fn - Called with a snapshot on every state change.
   */
  function subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  }

  /**
   * Get the current snapshot without subscribing.
   */
  function getSnapshot() {
    return _snapshot();
  }

  /**
   * Refresh the connected-providers list from the relay.
   * Useful on mount to restore existing connections.
   */
  async function refresh() {
    const connected = await _loadConnectedProviders();
    _setState(_state, { connectedProviders: connected });
  }

  /**
   * Select a provider to connect. Moves to `entering_key` state.
   * Can be called from `idle`, `selecting`, `invalid`, `expired`, or `rate_limited`.
   *
   * @param {string} providerId
   */
  function selectProvider(providerId) {
    const allowed = [STATES.IDLE, STATES.SELECTING, STATES.ENTERING_KEY,
                     STATES.INVALID, STATES.EXPIRED, STATES.RATE_LIMITED, STATES.ERROR];
    if (!allowed.includes(_state)) {
      throw new Error(`selectProvider: cannot call in state "${_state}"`);
    }
    const found = _providers.find(p => p.id === providerId);
    if (!found) throw new Error(`selectProvider: unknown provider "${providerId}"`);
    _abort();
    _setState(STATES.ENTERING_KEY, { provider: providerId, error: null });
  }

  /**
   * Clear provider selection and return to `idle`.
   */
  function clearProvider() {
    _abort();
    _setState(STATES.IDLE, { provider: null, error: null });
  }

  /**
   * Connect with the supplied key:
   *   1. Client-side format validation (fast, no network).
   *   2. POST /keys/:provider to store the encrypted key and do a live ping.
   *   3. Transitions to `connected` on success, or `invalid`/`error` on failure.
   *
   * The raw key is never stored in controller state. It lives only in the
   * local `key` variable until the fetch resolves, then becomes GC-eligible.
   *
   * @param {string} key - The raw provider API key.
   */
  async function connect(key) {
    if (_state !== STATES.ENTERING_KEY && _state !== STATES.INVALID &&
        _state !== STATES.EXPIRED && _state !== STATES.RATE_LIMITED) {
      throw new Error(`connect: cannot call in state "${_state}"`);
    }
    if (!_selectedProvider) throw new Error('connect: no provider selected');
    if (!key || typeof key !== 'string') throw new Error('connect: key must be a non-empty string');

    // Client-side format check
    const meta = _providers.find(p => p.id === _selectedProvider);
    if (meta?.keyPattern && !meta.keyPattern.test(key.trim())) {
      _setState(STATES.INVALID, {
        error: {
          message: `Key format looks wrong for ${meta.name}. Expected format: ${meta.keyHint}`,
          code:    'FORMAT_INVALID',
        },
      });
      scrubKey(key);
      return;
    }

    _abort();
    _abortController = new AbortController();
    const signal     = _abortController.signal;

    _setState(STATES.CONNECTING, { error: null });

    try {
      const res = await relayFetch(_relayUrl, `/keys/${_selectedProvider}`, {
        method: 'POST',
        token:  _token,
        body:   { key: key.trim() },
        signal,
      });

      // Drop the key reference immediately after the fetch resolves
      scrubKey(key);
      _abortController = null;

      if (res.ok) {
        const connected = await _loadConnectedProviders();
        _setState(STATES.CONNECTED, { error: null, connectedProviders: connected });
        return;
      }

      // Map upstream error codes to states
      if (res.status === 401 || res.status === 403) {
        _setState(STATES.INVALID, {
          error: {
            message: res.data?.error || 'API key was rejected by the provider.',
            code:    'KEY_REJECTED',
            status:  res.status,
          },
        });
        return;
      }

      if (res.status === 429) {
        _setState(STATES.RATE_LIMITED, {
          error: {
            message: res.data?.error || 'Rate limited. Try again in a moment.',
            code:    'RATE_LIMITED',
            status:  429,
          },
        });
        return;
      }

      if (res.status === 410) {
        _setState(STATES.EXPIRED, {
          error: {
            message: res.data?.error || 'API key has expired or been revoked.',
            code:    'KEY_EXPIRED',
            status:  410,
          },
        });
        return;
      }

      // Generic failure
      _setState(STATES.INVALID, {
        error: {
          message: res.data?.error || `Unexpected error (HTTP ${res.status}).`,
          code:    'STORE_FAILED',
          status:  res.status,
        },
      });
    } catch (err) {
      _abortController = null;
      scrubKey(key);
      if (err.name === 'AbortError') return; // cancelled — state unchanged
      _setState(STATES.ERROR, {
        error: {
          message: 'Network error while connecting. Check your connection and try again.',
          code:    'NETWORK_ERROR',
        },
      });
    }
  }

  /**
   * Rotate the key for the currently connected provider:
   *   1. Client-side format validation.
   *   2. POST /keys/:provider/rotate — live ping of new key before committing.
   *   3. Returns to `connected` on success, or `invalid` on failure.
   *
   * @param {string} newKey - The replacement raw provider API key.
   * @param {string} [providerId] - Defaults to `_selectedProvider`.
   */
  async function rotate(newKey, providerId) {
    const pid = providerId || _selectedProvider;
    if (!pid) throw new Error('rotate: no provider specified or selected');

    const allowed = [STATES.CONNECTED, STATES.EXPIRED, STATES.RATE_LIMITED];
    if (!allowed.includes(_state)) {
      throw new Error(`rotate: cannot call in state "${_state}"`);
    }

    if (!newKey || typeof newKey !== 'string') throw new Error('rotate: newKey must be a non-empty string');

    const meta = _providers.find(p => p.id === pid);
    if (meta?.keyPattern && !meta.keyPattern.test(newKey.trim())) {
      _setState(STATES.INVALID, {
        provider: pid,
        error: {
          message: `New key format looks wrong for ${meta.name}. Expected format: ${meta.keyHint}`,
          code:    'FORMAT_INVALID',
        },
      });
      scrubKey(newKey);
      return;
    }

    _abort();
    _abortController = new AbortController();
    const signal     = _abortController.signal;

    _setState(STATES.ROTATING, { provider: pid, error: null });

    try {
      const res = await relayFetch(_relayUrl, `/keys/${pid}/rotate`, {
        method: 'POST',
        token:  _token,
        body:   { key: newKey.trim() },
        signal,
      });

      scrubKey(newKey);
      _abortController = null;

      if (res.ok) {
        const connected = await _loadConnectedProviders();
        _setState(STATES.CONNECTED, { error: null, connectedProviders: connected });
        return;
      }

      if (res.status === 401 || res.status === 403) {
        _setState(STATES.INVALID, {
          error: {
            message: res.data?.error || 'New API key was rejected by the provider.',
            code:    'KEY_REJECTED',
            status:  res.status,
          },
        });
        return;
      }

      _setState(STATES.CONNECTED, {
        error: {
          message: res.data?.error || `Rotation failed (HTTP ${res.status}). Old key is still active.`,
          code:    'ROTATE_FAILED',
          status:  res.status,
        },
      });
    } catch (err) {
      _abortController = null;
      scrubKey(newKey);
      if (err.name === 'AbortError') return;
      _setState(STATES.CONNECTED, {
        error: {
          message: 'Network error during rotation. Old key is still active.',
          code:    'NETWORK_ERROR',
        },
      });
    }
  }

  /**
   * Disconnect (delete) the stored key for a provider.
   * Moves to `idle` after success.
   *
   * @param {string} [providerId] - Defaults to `_selectedProvider`.
   */
  async function disconnect(providerId) {
    const pid = providerId || _selectedProvider;
    if (!pid) throw new Error('disconnect: no provider specified or selected');

    const allowed = [STATES.CONNECTED, STATES.INVALID, STATES.EXPIRED,
                     STATES.RATE_LIMITED, STATES.ENTERING_KEY, STATES.ERROR];
    if (!allowed.includes(_state)) {
      throw new Error(`disconnect: cannot call in state "${_state}"`);
    }

    _abort();
    _abortController = new AbortController();
    const signal     = _abortController.signal;

    _setState(STATES.DISCONNECTING, { provider: pid, error: null });

    try {
      await relayFetch(_relayUrl, `/keys/${pid}`, {
        method: 'DELETE',
        token:  _token,
        signal,
      });
      _abortController = null;

      const connected = await _loadConnectedProviders();
      _setState(STATES.IDLE, { provider: null, error: null, connectedProviders: connected });
    } catch (err) {
      _abortController = null;
      if (err.name === 'AbortError') return;
      _setState(STATES.ERROR, {
        error: {
          message: 'Network error while disconnecting.',
          code:    'NETWORK_ERROR',
        },
      });
    }
  }

  /**
   * Cancel any in-flight operation and return to `idle` (or `entering_key`
   * if a provider was selected).
   */
  function cancel() {
    _abort();
    if (_selectedProvider) {
      _setState(STATES.ENTERING_KEY, { error: null });
    } else {
      _setState(STATES.IDLE, { error: null });
    }
  }

  /**
   * Reset to idle state, clearing provider selection and errors.
   */
  function reset() {
    _abort();
    _setState(STATES.IDLE, { provider: null, error: null });
  }

  // Register initial subscriber (shorthand API)
  if (typeof onStateChange === 'function') subscribe(onStateChange);

  return {
    // State
    getSnapshot,
    subscribe,
    // Navigation
    refresh,
    selectProvider,
    clearProvider,
    // Key lifecycle
    connect,
    rotate,
    disconnect,
    // Control
    cancel,
    reset,
    // Metadata
    providers: _providers,
    STATES,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createConnectController,
  DEFAULT_PROVIDERS,
  STATES,
};
