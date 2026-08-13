# @byok-relay/mcp

> MCP server for [byok-relay](https://byokrelay.com) — use BYOK AI keys from Claude Desktop, Claude Code, and any MCP-compatible client.

Exposes byok-relay as a set of [Model Context Protocol](https://modelcontextprotocol.io) tools so AI assistants can relay requests through users' own API keys without exposing them to the client.

## Tools

| Tool | Description |
|------|-------------|
| `byok_relay_health` | Check relay server health |
| `byok_relay_register` | Register and get a relay token |
| `byok_relay_store_key` | Store a provider API key (encrypted at rest) |
| `byok_relay_request` | Forward any provider API request |
| `byok_relay_chat` | Send a chat completion (unified model routing) |
| `byok_relay_stats` | Get usage statistics |

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "byok-relay": {
      "command": "npx",
      "args": ["-y", "@byok-relay/mcp"],
      "env": {
        "RELAY_URL": "https://relay.byokrelay.com",
        "APP_ID": "claude-desktop"
      }
    }
  }
}
```

Restart Claude Desktop. The byok-relay tools will appear in the tool list. Use `byok_relay_register` first, copy the returned token into the config as `RELAY_TOKEN`, then restart Claude Desktop again before calling authenticated tools such as `byok_relay_store_key` or `byok_relay_chat`.

### Claude Code / Cursor / Windsurf

Add to your project's MCP config (`.mcp.json` or editor settings):

```json
{
  "servers": {
    "byok-relay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@byok-relay/mcp"],
      "env": {
        "RELAY_URL": "https://relay.byokrelay.com"
      }
    }
  }
}
```

Register first, then add `RELAY_TOKEN` and restart the MCP host before calling authenticated tools.

### Self-hosted relay

Replace `RELAY_URL` with your own relay URL:

```json
{
  "env": {
    "RELAY_URL": "http://localhost:3000",
    "RELAY_TOKEN": "<your-token>"
  }
}
```

## Getting a Relay Token

First time? Ask the MCP server to register you:

1. Start the MCP server without `RELAY_TOKEN` in the config.
2. In Claude Desktop, ask: *"Use byok_relay_register to register me with app_id my-app"*.
3. Claude calls `byok_relay_register` and returns your `token`.
4. Copy the token into your MCP config as `RELAY_TOKEN`.
5. Restart Claude Desktop so later tool calls use the new token.

Or register via curl:

```bash
curl -s -X POST https://relay.byokrelay.com/users \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"my-app"}'
# → {"token": "...", "expires_at": "..."}
```

## Storing API Keys

Once registered, store your provider keys:

```
Ask Claude: "Use byok_relay_store_key to store my OpenAI key sk-... for provider openai"
```

Keys are encrypted with AES-256-GCM and never returned after storage.

## Example Conversations

**Check relay health:**
> "Use byok_relay_health to check if the relay is up"

**Make a chat request:**
> "Use byok_relay_chat with model gpt-4o to translate 'Hello world' to Spanish"

**Get usage stats:**
> "Use byok_relay_stats to show how many requests I've made"

**Forward a raw API call:**
> "Use byok_relay_request with provider anthropic, path /v1/messages, to ask claude-haiku-3-5 what 2+2 is"

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_URL` | No | `https://relay.byokrelay.com` | byok-relay server URL |
| `RELAY_TOKEN` | Yes (for most tools) | — | Your relay token from registration |
| `APP_ID` | No | `mcp-client` | App identifier used when registering |

## Self-Hosting

Run your own relay:

```bash
# Docker
docker run -p 3000:3000 \
  -e ENCRYPTION_SECRET=$(openssl rand -hex 32) \
  ghcr.io/avikalpg/byok-relay:latest

# npm
npx byok-relay
```

Then set `RELAY_URL=http://localhost:3000` in your MCP config.

See the [byok-relay README](https://github.com/avikalpg/byok-relay) for full self-hosting docs.

## Links

- [byok-relay repo](https://github.com/avikalpg/byok-relay)
- [byokrelay.com](https://byokrelay.com)
- [MCP protocol](https://modelcontextprotocol.io)
- [Issues](https://github.com/avikalpg/byok-relay/issues)

## License

Apache 2.0
