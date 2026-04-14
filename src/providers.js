/**
 * Provider-specific request forwarding.
 * Each provider defines how to build and send requests using the user's API key.
 */
const fetch = require('node-fetch');

const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    buildHeaders: (apiKey, extraHeaders = {}) => ({
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': extraHeaders['anthropic-version'] || '2023-06-01',
      ...Object.fromEntries(
        Object.entries(extraHeaders).filter(([k]) =>
          k.startsWith('anthropic-') && k !== 'anthropic-version'
        )
      ),
    }),
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }),
  },
};

/**
 * Forward a request to the AI provider.
 * Returns a node-fetch Response (streaming-capable).
 */
async function forwardRequest(provider, path, method, body, apiKey, extraHeaders = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const url = `${config.baseUrl}${path}`;
  const headers = config.buildHeaders(apiKey, extraHeaders);

  const response = await fetch(url, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });

  return response;
}

module.exports = { forwardRequest, SUPPORTED_PROVIDERS: Object.keys(PROVIDERS) };
