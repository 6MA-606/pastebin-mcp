# pastebin-mcp

Pastebin MCP server on **Cloudflare Workers** (stateless Streamable HTTP).

Each calling agent supplies its **own API key** (`Authorization: Bearer …`). There is no shared Worker secret for client auth. Pastes are scoped to the key that created them. The server does **not** implement OAuth (discovery paths return 404) so Cursor uses your configured headers.

## MCP endpoint

```text
https://pastebin-mcp.zyxma-6666.workers.dev/mcp
```

## Mint an API key

```bash
curl -sS -X POST https://pastebin-mcp.zyxma-6666.workers.dev/v1/keys \
  -H 'content-type: application/json' \
  -d '{"label":"cursor-agent"}'
```

Save `api_key` from the response — it is shown only once (the Worker stores a SHA-256 hash).

You can also generate any ≥24-character secret yourself and send it as the Bearer token; the first request registers its hash.

## Add in Cursor / agents

Mint a key first, put it in your environment (do **not** commit the key), then add:

**Cursor MCP** (`~/.cursor/mcp.json` or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pastebin": {
      "url": "https://pastebin-mcp.zyxma-6666.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PASTEBIN_API_KEY}"
      }
    }
  }
}
```

Set `PASTEBIN_API_KEY` in your shell/profile (or Cursor env), then reload MCP. Prefer `${env:…}` over pasting a raw key into `mcp.json`.

**Claude Code:**

```bash
claude mcp add --transport http pastebin \
  https://pastebin-mcp.zyxma-6666.workers.dev/mcp \
  --header "Authorization: Bearer ${PASTEBIN_API_KEY}"
```

**Agents SDK** (`addMcpServer`):

```ts
await agent.addMcpServer(
  "pastebin",
  "https://pastebin-mcp.zyxma-6666.workers.dev/mcp",
  {
    transport: {
      headers: { Authorization: `Bearer ${process.env.PASTEBIN_API_KEY}` },
    },
  },
);
```

Alternate header: `X-API-Key` with the same key value.

## Tools

| Tool | Description |
|------|-------------|
| `create_paste` | Create a paste (`content`, optional `title`, `language`) |
| `get_paste` | Fetch by `id` (own key only) |
| `list_pastes` | List summaries (newest first) |
| `delete_paste` | Delete by `id` |
| `whoami` | Show key fingerprint (not the secret) |

## Local development

```bash
npm install
npm run dev
```

Then mint a key against `http://127.0.0.1:8787/v1/keys` and point your MCP client at `http://127.0.0.1:8787/mcp`.

## Deploy

```bash
npm install
npx wrangler deploy
```

Requires Cloudflare auth (`wrangler login` or `CLOUDFLARE_API_TOKEN`). KV namespace binding `PASTES` is configured in `wrangler.jsonc`.

## Secrets Sittha must set

None for client auth. Agents mint or choose their own keys.

Optional ops only:

- Cloudflare account access for future deploys (`wrangler login` / API token with Workers + KV edit)
- Keep your personal pastebin API key private (treat like a password)
