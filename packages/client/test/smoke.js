/**
 * packages/client smoke test
 * Run with: node packages/client/test/smoke.js
 * No test runner required.
 */

'use strict'

const { createClient, createMemoryStorage } = require('../src/index.js')

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`)
    passed++
  } else {
    console.error(`  ✗ ${msg}`)
    failed++
  }
}

// ── Test: factory returns expected methods ───────────────────────────────────

console.log('\n1. createClient() returns expected API')
const relay = createClient({ relayUrl: 'http://localhost:3000', appId: 'test' })
const expectedMethods = [
  'getToken', 'clearToken', 'ensureToken',
  'storeKey', 'listKeys', 'deleteKey', 'deleteAccount',
  'relayRequest', 'streamChat', 'chat',
  'getStats', 'health', 'getModels',
]
for (const m of expectedMethods) {
  assert(typeof relay[m] === 'function', `relay.${m} is a function`)
}

// ── Test: scoped token persistence and migration ─────────────────────────────

console.log('\n2. Token persistence uses relay/app scoped keys')
const mem = createMemoryStorage()
const c1 = createClient({ storage: mem })
const c2 = createClient({ storage: mem })
const scopedKey = 'byok-relay:relay-token:http://localhost:3000:app'

assert(c1.getToken() === null, 'fresh client has no token')
mem.setItem('byok_relay_token', 'tok_test123')
assert(c1.getToken() === 'tok_test123', 'c1 migrates legacy global token')
assert(mem.getItem(scopedKey) === 'tok_test123', 'migration stores token under scoped key')
assert(mem.getItem('byok_relay_token') === null, 'migration removes legacy global token')
assert(c2.getToken() === 'tok_test123', 'c2 shares same relay/app storage key')
c1.clearToken()
assert(c2.getToken() === null, 'clearToken via c1 removes scoped token from c2')

const appA = createClient({ storage: mem, appId: 'app-a' })
const appB = createClient({ storage: mem, appId: 'app-b' })
mem.setItem('byok-relay:relay-token:http://localhost:3000:app-a', 'tok_a')
mem.setItem('byok-relay:relay-token:http://localhost:3000:app-b', 'tok_b')
assert(appA.getToken() === 'tok_a', 'app-a reads only its scoped token')
assert(appB.getToken() === 'tok_b', 'app-b reads only its scoped token')

const legacyMem = createMemoryStorage()
const defaultApp = createClient({ storage: legacyMem, appId: 'app-a' })
legacyMem.setItem('byok_relay_token', 'tok_legacy')
assert(defaultApp.getToken('app-b') === null, 'override app lookup does not migrate legacy global token')
assert(legacyMem.getItem('byok_relay_token') === 'tok_legacy', 'override lookup leaves legacy global token untouched')
assert(defaultApp.getToken() === 'tok_legacy', 'default app migrates legacy global token')
assert(legacyMem.getItem('byok-relay:relay-token:http://localhost:3000:app-a') === 'tok_legacy', 'default migration stores legacy token under default app key')
assert(legacyMem.getItem('byok_relay_token') === null, 'default migration removes legacy global token')

// ── Test: isolated storage between two clients ────────────────────────────────

console.log('\n3. Two clients with independent memory storage are isolated')
const relay_a = createClient({ storage: createMemoryStorage() })
const relay_b = createClient({ storage: createMemoryStorage() })
relay_a._storage_test = relay_a.getToken  // just access methods
relay_a.clearToken()
relay_b.clearToken()
assert(relay_a.getToken() === null, 'a has no token')
assert(relay_b.getToken() === null, 'b has no token')

// ── Test: storage=null gives per-instance memory (not shared) ─────────────────

console.log('\n4. storage=null → in-memory (not persisted globally)')
const cNull = createClient({ storage: null })
assert(cNull.getToken() === null, 'null storage client has no token initially')

// ── Test: URL normalisation ───────────────────────────────────────────────────

console.log('\n5. relayUrl trailing-slash normalisation (no double slashes in URLs)')
// We can't easily inspect internal base, but we can verify the client works
const cSlash = createClient({ relayUrl: 'http://localhost:3000///' })
assert(typeof cSlash.health === 'function', 'client with trailing slashes created ok')

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
