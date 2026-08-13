/**
 * @byok-relay/react — smoke tests (Node, no browser/DOM)
 *
 * Tests the non-hook utilities and verifiable logic.
 * Full hook integration requires a React test environment (e.g. @testing-library/react).
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

// ─── Test: package exports ────────────────────────────────────────────────────

console.log('\npackage exports');

// Simulate React environment (provide stubs for hooks)
global.React = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
};
const {
  useState,
  useCallback,
  useRef,
  useEffect,
} = global.React;
// Patch require so the module finds 'react'
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'react') return global.React;
  return originalLoad.call(this, request, ...rest);
};

const pkg = require('../src/index.js');

assert('exports useByokRelay', typeof pkg.useByokRelay === 'function');
assert('exports useChat', typeof pkg.useChat === 'function');
assert('exports useStreamingChat', typeof pkg.useStreamingChat === 'function');
assert('exports useRelayHealth', typeof pkg.useRelayHealth === 'function');

// ─── Test: storage helpers (indirectly via module) ────────────────────────────

console.log('\nstorage helpers (localStorage absent = no-op)');

// localStorage is not defined in Node — helpers should not throw
assert('storageGet does not throw without localStorage', (() => {
  try { pkg.useByokRelay({ appId: 'test' }); return true; }
  catch { return false; }
})());

// ─── Test: PROVIDER_PATHS coverage ───────────────────────────────────────────

console.log('\nProvider path resolution (via useChat init)');

const EXPECTED_PROVIDERS = ['openai', 'anthropic', 'groq', 'mistral', 'openrouter'];
for (const p of EXPECTED_PROVIDERS) {
  assert(`useChat initialises with provider=${p}`, (() => {
    try {
      pkg.useChat({ appId: 'test', provider: p, model: 'test-model' });
      return true;
    } catch { return false; }
  })());
}

// ─── Test: useRelayHealth init ────────────────────────────────────────────────

console.log('\nuseRelayHealth');

assert('useRelayHealth initialises', (() => {
  try {
    const result = pkg.useRelayHealth({ relayUrl: 'https://relay.byokrelay.com' });
    return result !== null && typeof result === 'object';
  } catch { return false; }
})());

// ─── Test: useStreamingChat init ──────────────────────────────────────────────

console.log('\nuseStreamingChat');

assert('useStreamingChat initialises', (() => {
  try {
    const result = pkg.useStreamingChat({ appId: 'test' });
    return result !== null && typeof result === 'object';
  } catch { return false; }
})());

// ─── Test: package.json validity ─────────────────────────────────────────────

console.log('\npackage.json');

const pkgJson = require('../package.json');
assert('has name @byok-relay/react', pkgJson.name === '@byok-relay/react');
assert('has main entry', Boolean(pkgJson.main));
assert('has react in peerDependencies', Boolean(pkgJson.peerDependencies?.react));
assert('has license MIT', pkgJson.license === 'MIT');
assert('has keywords array', Array.isArray(pkgJson.keywords) && pkgJson.keywords.length >= 5);

// ─── Token storage and hook-state regressions ────────────────────────────────

console.log('\ntoken storage helpers');

assert('exports internal test helpers', Boolean(pkg.__testing?.tokenStorageKey));

const collisionA = ['https://relay.example/a', 'b_c'];
const collisionB = ['https://relay.example/a_b', 'c'];
assert(
  'legacy token key format is ambiguous for underscore-separated inputs',
  pkg.__testing.legacyTokenStorageKey(...collisionA) === pkg.__testing.legacyTokenStorageKey(...collisionB),
);
assert(
  'v2 token key format is collision-resistant for structured scope',
  pkg.__testing.tokenStorageKey(...collisionA) !== pkg.__testing.tokenStorageKey(...collisionB),
);

function createLocalStorageMock() {
  const store = new Map();
  return {
    getItem: (key) => store.has(String(key)) ? store.get(String(key)) : null,
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => { store.clear(); },
    _dump: () => Object.fromEntries(store.entries()),
  };
}

global.localStorage = createLocalStorageMock();
const legacyKey = pkg.__testing.legacyTokenStorageKey('https://relay.example', 'legacy_app');
const modernKey = pkg.__testing.tokenStorageKey('https://relay.example', 'legacy_app');
global.localStorage.setItem(legacyKey, 'legacy-token');
assert('readStoredToken falls back to legacy key', pkg.__testing.readStoredToken(modernKey, legacyKey) === 'legacy-token');
assert('readStoredToken migrates legacy token to v2 key', global.localStorage.getItem(modernKey) === 'legacy-token');

function depsChanged(prev = [], next = []) {
  if (!prev || prev.length !== next.length) return true;
  return next.some((value, index) => value !== prev[index]);
}

function createHookRunner() {
  const state = [];
  let cursor = 0;

  const react = {
    useState(init) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init;
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next;
      }];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      const prev = state[index];
      if (!prev || depsChanged(prev.deps, deps)) state[index] = { deps, value: fn };
      return state[index].value;
    },
    useRef(init) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: init };
      return state[index];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const prev = state[index];
      if (!prev || depsChanged(prev.deps, deps)) {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        state[index] = { deps, cleanup: fn() };
      }
    },
  };

  return {
    react,
    render(fn) {
      cursor = 0;
      return fn();
    },
    cleanup() {
      for (const entry of state) {
        if (typeof entry?.cleanup === 'function') entry.cleanup();
      }
    },
  };
}

function reloadPackageWithReact(react) {
  global.React = react;
  delete require.cache[require.resolve('../src/index.js')];
  return require('../src/index.js');
}

function tick() {
  return Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function runAsyncRegressionTests() {
  console.log('\nhook token scope changes');
  {
    const runner = createHookRunner();
    const mod = reloadPackageWithReact(runner.react);
    global.localStorage = createLocalStorageMock();
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/users')) {
        const userCalls = calls.filter((call) => call.url.endsWith('/users')).length;
        return { ok: true, json: async () => ({ token: `token-${userCalls}` }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    let hook = runner.render(() => mod.useByokRelay({ relayUrl: 'https://relay.example/a', appId: 'app1' }));
    await hook.register();
    hook = runner.render(() => mod.useByokRelay({ relayUrl: 'https://relay.example/b', appId: 'app2' }));
    await hook.storeKey('openai', 'sk-test');

    const userCalls = calls.filter((call) => call.url.endsWith('/users'));
    const storeCalls = calls.filter((call) => call.url.endsWith('/keys/openai'));
    assert('relayUrl/appId change triggers a new token registration', userCalls.length === 2);
    assert('storeKey after scope change uses the new token', storeCalls.at(-1)?.headers?.['x-relay-token'] === 'token-2');
    runner.cleanup();
  }

  console.log('\nlogout invalidates pending token registration');
  {
    const runner = createHookRunner();
    const mod = reloadPackageWithReact(runner.react);
    global.localStorage = createLocalStorageMock();
    const pending = [];
    global.fetch = (url) => {
      if (url.endsWith('/users')) {
        const registration = deferred();
        pending.push(registration);
        return registration.promise;
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    };

    let hooks = runner.render(() => [
      mod.useByokRelay({ relayUrl: 'https://relay.example', appId: 'app' }),
      mod.useByokRelay({ relayUrl: 'https://relay.example', appId: 'app' }),
    ]);
    const result = hooks[0].register().then(() => 'resolved', (error) => error);
    await tick();
    hooks[1].logout();
    pending[0].resolve({ ok: true, json: async () => ({ token: 'late-token' }) });
    const outcome = await result;
    hooks = runner.render(() => [
      mod.useByokRelay({ relayUrl: 'https://relay.example', appId: 'app' }),
      mod.useByokRelay({ relayUrl: 'https://relay.example', appId: 'app' }),
    ]);

    assert('pending registration rejects after logout', outcome?.name === 'AbortError');
    assert('pending registration does not persist a token after logout', Object.keys(global.localStorage._dump()).length === 0);
    assert('logout clears sibling hook token state', hooks[0].token === null && hooks[1].token === null);
    runner.cleanup();
  }

  console.log('\nuseRelayHealth request ordering');
  {
    const runner = createHookRunner();
    const mod = reloadPackageWithReact(runner.react);
    const pending = [];
    global.fetch = (url, options = {}) => new Promise((resolve) => {
      pending.push({ url, signal: options.signal, resolve });
    });

    let health = runner.render(() => mod.useRelayHealth({ relayUrl: 'https://relay.example', intervalMs: 0 }));
    await tick();
    const manual = health.refetch();
    await tick();

    pending[1].resolve({ ok: true, json: async () => ({ request: 'manual' }) });
    await manual;
    pending[0].resolve({ ok: true, json: async () => ({ request: 'stale-poll' }) });
    await tick();
    await tick();
    health = runner.render(() => mod.useRelayHealth({ relayUrl: 'https://relay.example', intervalMs: 0 }));

    assert('manual health refetch aborts the older poll request', pending[0].signal.aborted === true);
    assert('older health response cannot overwrite newer refetch data', health.data?.request === 'manual');
    runner.cleanup();
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

runAsyncRegressionTests()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
  });
