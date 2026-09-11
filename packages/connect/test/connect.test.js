/**
 * @byok-relay/connect — unit tests
 *
 * Tests the headless state machine logic without a browser or relay server.
 * Network calls are intercepted via global.fetch stub.
 */

'use strict';

process.env.NODE_ENV = 'test';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function assertThrows(label, fn) {
  try {
    fn();
    console.error(`  ❌ ${label} (expected throw, but did not throw)`);
    failed++;
  } catch {
    console.log(`  ✅ ${label}`);
    passed++;
  }
}

async function assertRejects(label, fn) {
  try {
    await fn();
    console.error(`  ❌ ${label} (expected rejection, but resolved)`);
    failed++;
  } catch {
    console.log(`  ✅ ${label}`);
    passed++;
  }
}

// ─── Fake fetch ───────────────────────────────────────────────────────────────

let _fetchQueue = [];

function enqueueFetch(response) {
  _fetchQueue.push(response);
}

function clearFetchQueue() {
  _fetchQueue = [];
}

global.fetch = async (url, opts) => {
  const next = _fetchQueue.shift();
  if (!next) throw new Error(`fetch: unexpected call to ${url}`);
  if (next === 'ABORT') {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (next === 'NETWORK_ERROR') {
    throw new TypeError('Failed to fetch');
  }
  const { status = 200, body = {} } = next;
  return {
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => body,
  };
};

// ─── Load module ──────────────────────────────────────────────────────────────

const { createConnectController, DEFAULT_PROVIDERS, STATES } = require('../src/index');

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtrl(overrides = {}) {
  clearFetchQueue();
  return createConnectController({ relayUrl: 'http://localhost:3000', token: 'test-token', ...overrides });
}

/** Attach a subscriber and return the captured snapshots array. */
function snapshots(ctrl) {
  const snaps = [];
  ctrl.subscribe(s => snaps.push({ state: s.state, provider: s.provider, error: s.error,
                                   connectedProviders: { ...s.connectedProviders } }));
  return snaps;
}

/** Returns all states visited (for presence checks). */
function statesSeen(snaps) {
  return snaps.map(s => s.state);
}

// ─── Synchronous tests ────────────────────────────────────────────────────────

console.log('\ncreateConnectController — constructor validation');

assertThrows('throws when token is missing',   () => createConnectController({ relayUrl: 'http://x', token: '' }));
assertThrows('throws when token is undefined', () => createConnectController({ relayUrl: 'http://x' }));

{
  const ctrl = makeCtrl();
  const snap = ctrl.getSnapshot();
  assert('initial state is idle',            snap.state === STATES.IDLE);
  assert('initial provider is null',         snap.provider === null);
  assert('initial connectedProviders is {}', Object.keys(snap.connectedProviders).length === 0);
  assert('initial error is null',            snap.error === null);
  assert('providers list is non-empty',      snap.providers.length > 0);
  assert('STATES exposed on controller',     typeof ctrl.STATES === 'object');
}

console.log('\nSTATES constant');
{
  assert('IDLE',          STATES.IDLE === 'idle');
  assert('ENTERING_KEY',  STATES.ENTERING_KEY === 'entering_key');
  assert('CONNECTING',    STATES.CONNECTING === 'connecting');
  assert('CONNECTED',     STATES.CONNECTED === 'connected');
  assert('INVALID',       STATES.INVALID === 'invalid');
  assert('EXPIRED',       STATES.EXPIRED === 'expired');
  assert('RATE_LIMITED',  STATES.RATE_LIMITED === 'rate_limited');
  assert('ROTATING',      STATES.ROTATING === 'rotating');
  assert('DISCONNECTING', STATES.DISCONNECTING === 'disconnecting');
  assert('ERROR',         STATES.ERROR === 'error');
}

console.log('\nDEFAULT_PROVIDERS');
{
  const ids = DEFAULT_PROVIDERS.map(p => p.id);
  assert('openai in defaults',    ids.includes('openai'));
  assert('anthropic in defaults', ids.includes('anthropic'));
  assert('google in defaults',    ids.includes('google'));
  assert('groq in defaults',      ids.includes('groq'));
  assert('each has keyPattern',   DEFAULT_PROVIDERS.every(p => p.keyPattern instanceof RegExp));
  assert('each has docsUrl',      DEFAULT_PROVIDERS.every(p => typeof p.docsUrl === 'string'));
  assert('each has description',  DEFAULT_PROVIDERS.every(p => typeof p.description === 'string'));
}

console.log('\nselectProvider');
{
  const ctrl = makeCtrl();
  const snaps = snapshots(ctrl);

  ctrl.selectProvider('openai');
  assert('state becomes entering_key', snaps[0]?.state === STATES.ENTERING_KEY);
  assert('provider is openai',         snaps[0]?.provider === 'openai');
  assert('error is null',              snaps[0]?.error === null);

  // Re-select a different provider from entering_key is allowed
  ctrl.selectProvider('anthropic');
  assert('can re-select provider', snaps[1]?.state === STATES.ENTERING_KEY);
  assert('provider updated',       snaps[1]?.provider === 'anthropic');
}

{
  const ctrl = makeCtrl();
  assertThrows('throws for unknown provider', () => ctrl.selectProvider('nonexistent-provider'));
}

console.log('\nclearProvider');
{
  const ctrl = makeCtrl();
  const snaps = snapshots(ctrl);

  ctrl.selectProvider('openai');
  ctrl.clearProvider();
  assert('state returns to idle', snaps[1]?.state === STATES.IDLE);
  assert('provider cleared',      snaps[1]?.provider === null);
}

console.log('\nsubscribe / unsubscribe');
{
  const ctrl  = makeCtrl();
  let count = 0;
  const unsub = ctrl.subscribe(() => count++);
  ctrl.selectProvider('openai');
  assert('subscriber called on change', count === 1);
  unsub();
  ctrl.clearProvider();
  assert('subscriber not called after unsub', count === 1);
}

console.log('\ngetSnapshot');
{
  const ctrl = makeCtrl();
  ctrl.selectProvider('openai');
  const snap = ctrl.getSnapshot();
  assert('getSnapshot returns current state',    snap.state === STATES.ENTERING_KEY);
  assert('getSnapshot returns current provider', snap.provider === 'openai');
  // Mutating the returned snapshot must not affect controller
  snap.provider = 'mutated';
  assert('snapshot is a safe copy',              ctrl.getSnapshot().provider === 'openai');
}

console.log('\nreset');
{
  const ctrl  = makeCtrl();
  const snaps = snapshots(ctrl);
  ctrl.selectProvider('groq');
  ctrl.reset();
  assert('reset returns to idle', snaps[1]?.state === STATES.IDLE);
  assert('reset clears provider', snaps[1]?.provider === null);
  assert('reset clears error',    snaps[1]?.error === null);
}

console.log('\ncancel — with provider selected');
{
  const ctrl  = makeCtrl();
  const snaps = snapshots(ctrl);
  ctrl.selectProvider('openai');
  ctrl.cancel();
  // Provider was selected → stays in entering_key with provider preserved
  assert('cancel from entering_key → entering_key', snaps[1]?.state === STATES.ENTERING_KEY);
  assert('cancel preserves provider',               snaps[1]?.provider === 'openai');
}

console.log('\ncancel — from idle');
{
  const ctrl  = makeCtrl();
  const snaps = snapshots(ctrl);
  ctrl.cancel();
  assert('cancel from idle → idle', snaps[0]?.state === STATES.IDLE);
}

console.log('\ncustom providers');
{
  const custom = [{
    id:          'custom-ai',
    name:        'Custom AI',
    keyHint:     'cap_...',
    keyPattern:  /^cap_/,
    docsUrl:     'https://example.com',
    description: 'A custom AI',
  }];
  const ctrl = createConnectController({ relayUrl: 'http://localhost', token: 'tok', providers: custom });
  assert('custom providers exposed',  ctrl.providers.length === 1);
  assert('custom provider id',        ctrl.providers[0].id === 'custom-ai');
  ctrl.selectProvider('custom-ai');
  assert('can select custom provider', ctrl.getSnapshot().provider === 'custom-ai');
  assertThrows('default providers not accessible', () => ctrl.selectProvider('openai'));
}

// ─── Async tests ──────────────────────────────────────────────────────────────

(async () => {

  console.log('\nconnect — client-side format validation (no fetch)');
  {
    const ctrl  = makeCtrl();
    const snaps = snapshots(ctrl);
    ctrl.selectProvider('openai');

    // 'bad-key-format' does not match OpenAI pattern; no fetch should happen
    await ctrl.connect('bad-key-format');
    assert('invalid format → INVALID state', snaps[1]?.state === STATES.INVALID);
    assert('error has FORMAT_INVALID code',  snaps[1]?.error?.code === 'FORMAT_INVALID');
    assert('fetch queue still empty',        _fetchQueue.length === 0);
  }

  console.log('\nconnect — success (200)');
  {
    const ctrl  = makeCtrl();
    const snaps = snapshots(ctrl);
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 200, body: { ok: true } });                    // POST /keys/openai
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });       // GET /keys (refresh)

    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    assert('connecting state emitted',     statesSeen(snaps).includes(STATES.CONNECTING));
    assert('connected state reached',      ctrl.getSnapshot().state === STATES.CONNECTED);
    assert('connectedProviders updated',   ctrl.getSnapshot().connectedProviders.openai === true);
    assert('fetch queue drained',          _fetchQueue.length === 0);
  }

  console.log('\nconnect — 401 rejected key');
  {
    const ctrl  = makeCtrl();
    const snaps = snapshots(ctrl);
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 401, body: { error: 'Invalid API key' } });

    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    assert('401 → INVALID state',           ctrl.getSnapshot().state === STATES.INVALID);
    assert('error code KEY_REJECTED',        ctrl.getSnapshot().error?.code === 'KEY_REJECTED');
    assert('connecting state was transient', statesSeen(snaps).includes(STATES.CONNECTING));
  }

  console.log('\nconnect — 429 rate limited');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 429, body: { error: 'Rate limited' } });

    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    assert('429 → RATE_LIMITED state', ctrl.getSnapshot().state === STATES.RATE_LIMITED);
    assert('error code RATE_LIMITED',  ctrl.getSnapshot().error?.code === 'RATE_LIMITED');
  }

  console.log('\nconnect — 410 expired key');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 410, body: { error: 'Key expired' } });

    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    assert('410 → EXPIRED state',    ctrl.getSnapshot().state === STATES.EXPIRED);
    assert('error code KEY_EXPIRED', ctrl.getSnapshot().error?.code === 'KEY_EXPIRED');
  }

  console.log('\nconnect — network error');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');

    enqueueFetch('NETWORK_ERROR');

    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    assert('network error → ERROR state', ctrl.getSnapshot().state === STATES.ERROR);
    assert('error code NETWORK_ERROR',    ctrl.getSnapshot().error?.code === 'NETWORK_ERROR');
  }

  console.log('\nconnect — wrong state throws');
  {
    const ctrl = makeCtrl(); // idle
    await assertRejects('connect throws in idle state', () => ctrl.connect('sk-any'));
  }

  console.log('\nrotate — success');
  {
    const ctrl  = makeCtrl();
    const snaps = snapshots(ctrl);
    ctrl.selectProvider('openai');

    // connect
    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    // rotate
    enqueueFetch({ status: 200, body: { ok: true, rotated: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.rotate('sk-newkey1234567890abcdefghijklmnopqrstuvwx');

    assert('rotating state emitted', statesSeen(snaps).includes(STATES.ROTATING));
    assert('back to connected',      ctrl.getSnapshot().state === STATES.CONNECTED);
  }

  console.log('\nrotate — invalid new key format');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    // bad format — no fetch should occur
    await ctrl.rotate('bad-format');

    assert('bad format → INVALID state', ctrl.getSnapshot().state === STATES.INVALID);
    assert('error code FORMAT_INVALID',  ctrl.getSnapshot().error?.code === 'FORMAT_INVALID');
    assert('fetch queue empty',          _fetchQueue.length === 0);
  }

  console.log('\nrotate — 401 rejected new key');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    enqueueFetch({ status: 401, body: { error: 'Bad key' } });
    await ctrl.rotate('sk-newkey1234567890abcdefghijklmnopqrstuvwx');

    assert('401 rotation → INVALID state', ctrl.getSnapshot().state === STATES.INVALID);
    assert('error code KEY_REJECTED',      ctrl.getSnapshot().error?.code === 'KEY_REJECTED');
  }

  console.log('\nrotate — throws in wrong state');
  {
    const ctrl = makeCtrl(); // idle
    await assertRejects('rotate throws in idle state', () =>
      ctrl.rotate('sk-newkey1234567890abcdefghijklmnopqrstuvwx'));
  }

  console.log('\ndisconnect — success');
  {
    const ctrl  = makeCtrl();
    const snaps = snapshots(ctrl);
    ctrl.selectProvider('openai');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.connect('sk-testkey1234567890abcdefghijklmnopqrstuvwx');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: [] } });
    await ctrl.disconnect();

    assert('disconnecting state emitted',  statesSeen(snaps).includes(STATES.DISCONNECTING));
    assert('idle after disconnect',        ctrl.getSnapshot().state === STATES.IDLE);
    assert('provider cleared',             ctrl.getSnapshot().provider === null);
    assert('connectedProviders cleared',   Object.keys(ctrl.getSnapshot().connectedProviders).length === 0);
  }

  console.log('\ndisconnect — explicit providerId');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('anthropic');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['anthropic'] } });
    await ctrl.connect('sk-ant-api03-testkey1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234');

    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: [] } });
    await ctrl.disconnect('anthropic');

    assert('disconnected by explicit id', ctrl.getSnapshot().state === STATES.IDLE);
  }

  console.log('\ndisconnect — relay returns non-2xx (key not deleted)');
  {
    const ctrl = makeCtrl();
    ctrl.selectProvider('openai');
    enqueueFetch({ status: 200, body: { ok: true } });
    enqueueFetch({ status: 200, body: { providers: ['openai'] } });
    await ctrl.connect('sk-testkey12345678901234567890abcdefghijklmnopqrst');

    // Relay returns 500 — key is NOT deleted
    enqueueFetch({ status: 500, body: { error: 'Internal Server Error' } });
    await ctrl.disconnect();

    const snap = ctrl.getSnapshot();
    assert('500 disconnect → ERROR state',           snap.state === STATES.ERROR);
    assert('error code DISCONNECT_FAILED',           snap.error?.code === 'DISCONNECT_FAILED');
    assert('provider retained on disconnect failure', snap.provider === 'openai');
  }

  console.log('\ndisconnect — throws in wrong state');
  {
    const ctrl = makeCtrl(); // idle — no provider
    await assertRejects('disconnect throws when no provider', () => ctrl.disconnect());
  }

  console.log('\nrefresh — updates connectedProviders');
  {
    const ctrl = makeCtrl();
    enqueueFetch({ status: 200, body: { providers: ['anthropic', 'groq'] } });
    await ctrl.refresh();
    const snap = ctrl.getSnapshot();
    assert('refresh updates anthropic',   snap.connectedProviders.anthropic === true);
    assert('refresh updates groq',        snap.connectedProviders.groq === true);
    assert('refresh keeps idle state',    snap.state === STATES.IDLE);
  }

  console.log('\nrefresh — network error is silent');
  {
    const ctrl = makeCtrl();
    enqueueFetch('NETWORK_ERROR');
    await ctrl.refresh(); // should not throw
    assert('state stays idle on refresh error', ctrl.getSnapshot().state === STATES.IDLE);
    assert('connectedProviders empty on error', Object.keys(ctrl.getSnapshot().connectedProviders).length === 0);
  }

  // ─── Final report ───────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`@byok-relay/connect — ${passed + failed} tests: ${passed} pass, ${failed} fail`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
