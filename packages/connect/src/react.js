/**
 * @byok-relay/connect — React wrapper
 *
 * Wraps the headless ConnectController in a React hook.
 *
 * Usage:
 *   import { useConnectAI } from '@byok-relay/connect/react';
 *
 *   function MyComponent() {
 *     const { state, provider, connectedProviders, providers, actions } =
 *       useConnectAI({ relayUrl: 'https://relay.byokrelay.com', token });
 *
 *     if (state === 'idle') return <ProviderList providers={providers} onSelect={actions.selectProvider} />;
 *     if (state === 'entering_key') return <KeyInput onSubmit={actions.connect} onBack={actions.clearProvider} />;
 *     if (state === 'connecting') return <Spinner />;
 *     if (state === 'connected') return <Connected onDisconnect={() => actions.disconnect()} />;
 *     // ...
 *   }
 */

'use strict';

const { useState, useEffect, useCallback, useRef } = require('react');
const { createConnectController, DEFAULT_PROVIDERS, STATES } = require('./index');

/**
 * React hook for the Connect AI flow.
 *
 * @param {object} opts
 * @param {string}   opts.relayUrl    - Relay base URL. Default: https://relay.byokrelay.com
 * @param {string}   opts.token       - Relay token (x-relay-token).
 * @param {object[]} [opts.providers] - Override default provider list.
 * @param {boolean}  [opts.autoRefresh=true] - Fetch connected providers on mount.
 *
 * @returns {{
 *   state: string,
 *   provider: string|null,
 *   connectedProviders: object,
 *   providers: object[],
 *   error: object|null,
 *   actions: {
 *     selectProvider: (id: string) => void,
 *     clearProvider: () => void,
 *     connect: (key: string) => Promise<void>,
 *     rotate: (newKey: string, providerId?: string) => Promise<void>,
 *     disconnect: (providerId?: string) => Promise<void>,
 *     cancel: () => void,
 *     reset: () => void,
 *     refresh: () => Promise<void>,
 *   }
 * }}
 */
function useConnectAI({ relayUrl, token, providers, autoRefresh = true } = {}) {
  const ctrlRef  = useRef(null);
  const keyRef   = useRef(null);

  // Reinitialise the controller when any controller input changes.
  // Keying on relayUrl + token covers the most common cases; providers
  // identity is checked separately because arrays are referentially unstable.
  const ctrlKey = `${token || ''}|${relayUrl || ''}`;
  if (keyRef.current !== ctrlKey || ctrlRef.current?.__providers !== providers) {
    // Cancel any in-flight operation on the outgoing controller.
    if (ctrlRef.current) {
      try { ctrlRef.current.cancel(); } catch { /* ignore if already idle */ }
    }
    keyRef.current = ctrlKey;
    if (token) {
      const ctrl = createConnectController({ relayUrl, token, providers });
      ctrl.__providers = providers;
      ctrlRef.current  = ctrl;
    } else {
      ctrlRef.current = null;
    }
  }

  const [snap, setSnap] = useState(() => {
    return ctrlRef.current
      ? ctrlRef.current.getSnapshot()
      : { state: STATES.IDLE, provider: null, connectedProviders: {}, error: null, providers: providers || DEFAULT_PROVIDERS };
  });

  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;

    // Subscribe to state changes
    const unsub = ctrl.subscribe(setSnap);

    // Emit initial snapshot in case it changed between render and effect
    setSnap(ctrl.getSnapshot());

    // Fetch connected providers on mount
    if (autoRefresh) ctrl.refresh();

    return unsub;
  }, [token, relayUrl, autoRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = {
    selectProvider: useCallback((id) => ctrlRef.current?.selectProvider(id), []),
    clearProvider:  useCallback(() => ctrlRef.current?.clearProvider(), []),
    connect:        useCallback((key) => ctrlRef.current?.connect(key), []),
    rotate:         useCallback((newKey, pid) => ctrlRef.current?.rotate(newKey, pid), []),
    disconnect:     useCallback((pid) => ctrlRef.current?.disconnect(pid), []),
    cancel:         useCallback(() => ctrlRef.current?.cancel(), []),
    reset:          useCallback(() => ctrlRef.current?.reset(), []),
    refresh:        useCallback(() => ctrlRef.current?.refresh(), []),
  };

  return { ...snap, actions };
}

module.exports = { useConnectAI, STATES, DEFAULT_PROVIDERS };
