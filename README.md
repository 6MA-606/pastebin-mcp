# pastebin-mcp

MCP server on **Cloudflare Workers** that talks to **[pastebin.com](https://pastebin.com)** (official Developers API).

Each calling agent supplies its **own Pastebin Developer API Key** — nothing is baked into the Worker.

## MCP endpoint

```text
https://pastebin-mcp.zyxma-6666.workers.dev/mcp
```

## Get a Pastebin API key

1. Sign in at [pastebin.com](https://pastebin.com)
2. Open [Developers API](https://pastebin.com/doc_api) — your **api_dev_key** is shown there

Optional (list / delete / private pastes): obtain `api_user_key` via the MCP `login` tool or [api_login.php](https://pastebin.com/doc_api), then send it as `X-Pastebin-User-Key`.

## Add in Cursor

```json
{
  "mcpServers": {
    "pastebin": {
      "url": "https://pastebin-mcp.zyxma-6666.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PASTEBIN_API_DEV_KEY}"
      }
    }
  }
}
```

Set `PASTEBIN_API_DEV_KEY` to your Pastebin developer key (do not commit the key). For member features also set:

```json
"X-Pastebin-User-Key": "${env:PASTEBIN_API_USER_KEY}"
```

## Tools

| Tool | Description |
|------|-------------|
| `create_paste` | Create on pastebin.com → returns URL |
| `get_paste` | Fetch by id/URL |
| `list_pastes` | Member pastes (needs user key) |
| `delete_paste` | Delete member paste (needs user key) |
| `login` | Username/password → `api_user_key` |
| `whoami` | Shows whether user key is attached (never echoes secrets) |

## Local development

```bash
npm install
npm run dev
```

## Deploy

```bash
npx wrangler deploy
```

## Secrets

- **Worker:** none required for Pastebin (agents pass their own `api_dev_key`)
- **Client:** each agent’s Pastebin Developer API Key via Bearer / `X-API-Key`
