/**
 * relay.js — byok-relay client for this React Vite example
 *
 * Re-exports createClient from @byok-relay/client and provides a pre-configured
 * singleton wired to VITE_RELAY_URL (or localhost:3000 for local dev).
 *
 * Import individual functions:
 *   import { storeKey, streamChat, listKeys } from './relay.js'
 *
 * Or use the client directly:
 *   import { relay } from './relay.js'
 */

import { createClient } from '@byok-relay/client'

export { createClient }

export const relay = createClient({
  relayUrl: import.meta.env.VITE_RELAY_URL || 'http://localhost:3000',
  appId: 'react-vite-example',
})

// Named re-exports for drop-in backward compatibility
export const getToken = () => relay.getToken()
export const clearToken = () => relay.clearToken()
export const ensureToken = (appId) => relay.ensureToken(appId)
export const storeKey = (provider, apiKey) => relay.storeKey(provider, apiKey)
export const listKeys = () => relay.listKeys()
export const deleteKey = (provider) => relay.deleteKey(provider)
export const streamChat = (opts) => relay.streamChat(opts)
export const deleteAccount = () => relay.deleteAccount()
