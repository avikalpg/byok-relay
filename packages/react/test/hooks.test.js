/**
 * @byok-relay/react — smoke tests (Node, no browser/DOM)
 *
 * Tests the non-hook utilities and verifiable logic.
 * Full hook integration requires a React test environment (e.g. @testing-library/react).
 */

'use strict';

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

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
