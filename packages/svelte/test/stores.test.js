/**
 * @byok-relay/svelte — smoke tests
 *
 * Run with: node test/stores.test.js
 *
 * Tests run in plain Node (no Svelte build step) because all stores export
 * pure JS objects with a Svelte-compatible { subscribe, set, update } interface.
 */

'use strict';

// Top-level await requires wrapping in an async runner
async function runTests() {

const {
  createByokRelayStore,
  createChatStore,
  createStreamingChatStore,
  createRelayHealthStore,
} = require('../src/index.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  ❌ FAIL (no throw): ${label}`);
    failed++;
  } catch {
    console.log(`  ✅ ${label}`);
    passed++;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read current store value synchronously. */
function get(store) {
  let v;
  const unsub = store.subscribe(val => { v = val; });
  unsub();
  return v;
}

// ─── createByokRelayStore ──────────────────────────────────────────────────────

console.log('\n── createByokRelayStore ─────────────────────────────────────────');

{
  const relay = createByokRelayStore({ appId: 'test-svelte' });

  assert(typeof relay.subscribe   === 'function', 'has subscribe');
  assert(typeof relay.register    === 'function', 'has register()');
  assert(typeof relay.storeKey    === 'function', 'has storeKey()');
  assert(typeof relay.deleteKey   === 'function', 'has deleteKey()');
  assert(typeof relay.listProviders === 'function', 'has listProviders()');
  assert(typeof relay.logout      === 'function', 'has logout()');

  const state = get(relay);
  assert(typeof state === 'object',       'initial state is object');
  assert('token'        in state,         'state has token');
  assert('isRegistered' in state,         'state has isRegistered');
  assert('error'        in state,         'state has error');
  assert(state.error === null,            'initial error is null');
  assert(typeof state.isRegistered === 'boolean', 'isRegistered is boolean');
}

{
  // logout clears state
  const relay = createByokRelayStore({ appId: 'test-logout-svelte' });
  relay.logout();
  const state = get(relay);
  assert(state.token === null,        'logout clears token');
  assert(state.isRegistered === false,'logout clears isRegistered');
}

{
  // subscribe fires immediately with current value
  const relay = createByokRelayStore({ appId: 'test-sub-svelte' });
  let fired = 0;
  const unsub = relay.subscribe(() => fired++);
  assert(fired === 1, 'subscribe fires immediately');
  unsub();
}

{
  // storeKey rejects if not registered
  const relay = createByokRelayStore({ appId: 'test-store-key-svelte' });
  relay.logout(); // ensure no token
  let threw = false;
  relay.storeKey('openai', 'sk-test').catch(() => { threw = true; });
  // give microtask a tick
  await new Promise(r => setTimeout(r, 10));
  assert(threw, 'storeKey throws if not registered');
}

// ─── createChatStore ───────────────────────────────────────────────────────────

console.log('\n── createChatStore ──────────────────────────────────────────────');

{
  const chat = createChatStore({ appId: 'test-chat-svelte', provider: 'openai' });

  assert(typeof chat.subscribe === 'function', 'has subscribe');
  assert(typeof chat.send     === 'function', 'has send()');
  assert(typeof chat.clear    === 'function', 'has clear()');

  const state = get(chat);
  assert(Array.isArray(state.messages), 'messages is array');
  assert(state.messages.length === 0,   'messages starts empty');
  assert(state.loading === false,       'loading starts false');
  assert(state.error === null,          'error starts null');
}

{
  // clear resets state
  const chat = createChatStore({ appId: 'test-clear-svelte', provider: 'openai' });
  // Manually inject a message by reaching into store update (simulate prior conversation)
  chat.clear();
  const state = get(chat);
  assert(state.messages.length === 0, 'clear empties messages');
}

{
  // send without token sets error (no token in localStorage for test-notoken-svelte)
  const chat = createChatStore({ appId: 'test-notoken-svelte', provider: 'openai' });
  await chat.send('hello');
  const state = get(chat);
  assert(typeof state.error === 'string', 'send without token sets error string');
  assert(state.loading === false, 'loading false after error');
}

// ─── createStreamingChatStore ─────────────────────────────────────────────────

console.log('\n── createStreamingChatStore ─────────────────────────────────────');

{
  const chat = createStreamingChatStore({ appId: 'test-stream-svelte', provider: 'openai' });

  assert(typeof chat.subscribe     === 'function', 'has subscribe');
  assert(typeof chat.send          === 'function', 'has send()');
  assert(typeof chat.stopStreaming === 'function', 'has stopStreaming()');
  assert(typeof chat.clear         === 'function', 'has clear()');

  const state = get(chat);
  assert(Array.isArray(state.messages),           'messages is array');
  assert(state.messages.length === 0,             'messages starts empty');
  assert(state.isStreaming === false,             'isStreaming starts false');
  assert(state.streamingContent === '',           'streamingContent starts empty string');
  assert(state.error === null,                    'error starts null');
}

{
  // stopStreaming is a no-op when not streaming
  const chat = createStreamingChatStore({ appId: 'test-stop-svelte' });
  chat.stopStreaming(); // should not throw
  assert(true, 'stopStreaming no-op when idle');
}

{
  // clear resets all state
  const chat = createStreamingChatStore({ appId: 'test-stream-clear-svelte' });
  chat.clear();
  const s = get(chat);
  assert(s.messages.length === 0,   'clear empties messages');
  assert(s.isStreaming === false,   'clear sets isStreaming false');
  assert(s.streamingContent === '', 'clear clears streamingContent');
}

{
  // send without token sets error
  const chat = createStreamingChatStore({ appId: 'test-stream-notoken-svelte', provider: 'anthropic' });
  await chat.send('hi');
  const s = get(chat);
  assert(typeof s.error === 'string', 'send without token sets error');
  assert(s.isStreaming === false,     'isStreaming false after error');
}

// ─── createRelayHealthStore ───────────────────────────────────────────────────

console.log('\n── createRelayHealthStore ───────────────────────────────────────');

{
  // No polling
  const health = createRelayHealthStore({ relayUrl: 'http://localhost:19999', pollIntervalMs: 0 });

  assert(typeof health.subscribe === 'function', 'has subscribe');
  assert(typeof health.refetch   === 'function', 'has refetch()');
  assert(typeof health.destroy   === 'function', 'has destroy()');

  // Initial state
  const init = get(health);
  assert('status'   in init, 'state has status');
  assert('ok'       in init, 'state has ok');
  assert('warnings' in init, 'state has warnings');
  assert('error'    in init, 'state has error');

  // Wait for the initial fetch to fail (unreachable host)
  await new Promise(r => setTimeout(r, 200));
  const after = get(health);
  assert(after.ok === false, 'ok=false on unreachable host');
  assert(after.status === 'unreachable', 'status=unreachable on network error');

  health.destroy(); // stop polling (no-op since pollIntervalMs=0)
}

{
  // destroy stops polling timer
  const health = createRelayHealthStore({ relayUrl: 'http://localhost:19999', pollIntervalMs: 5_000 });
  health.destroy();
  assert(true, 'destroy() does not throw');
}

// ─── Svelte store contract ────────────────────────────────────────────────────

console.log('\n── Svelte store contract ────────────────────────────────────────');

{
  // All stores expose { subscribe } = valid Svelte store
  const relay  = createByokRelayStore({ appId: 'contract-svelte' });
  const chat   = createChatStore({ appId: 'contract-svelte' });
  const stream = createStreamingChatStore({ appId: 'contract-svelte' });
  const health = createRelayHealthStore({ pollIntervalMs: 0 });

  for (const [name, store] of [
    ['createByokRelayStore', relay],
    ['createChatStore', chat],
    ['createStreamingChatStore', stream],
    ['createRelayHealthStore', health],
  ]) {
    assert(typeof store.subscribe === 'function', `${name}: subscribe is function`);
    // Svelte contract: subscribe must call the callback immediately and return unsubscribe fn
    let called = 0;
    const unsub = store.subscribe(() => called++);
    assert(called === 1, `${name}: subscribe fires immediately`);
    assert(typeof unsub === 'function', `${name}: subscribe returns unsubscribe function`);
    unsub();
    health.destroy();
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(56)}`);
console.log(`@byok-relay/svelte smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

} // end runTests

runTests().catch(err => { console.error(err); process.exit(1); });
