import {
  ensureKeyRegistered,
  extractApiKey,
  generateApiKey,
  identityFromKey,
  isValidKeyFormat,
  type AgentIdentity,
} from "./auth";
import {
  handleMcpRpc,
  parseJsonRpcMessages,
  type McpToolDef,
  type McpToolHandler,
} from "./mcp-rpc";
import {
  createPaste,
  deletePaste,
  getPaste,
  listPastes,
  publicPaste,
} from "./pastes";

export interface Env {
  PASTES: KVNamespace;
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function unauthorized(message = "Missing or invalid API key"): Response {
  return json(
    {
      error: "unauthorized",
      message,
      hint: "Pass Authorization: Bearer <api_key> (or X-API-Key). Mint a key with POST /v1/keys.",
    },
    401,
    { "WWW-Authenticate": 'Bearer realm="pastebin-mcp"' },
  );
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<AgentIdentity | Response> {
  const key = extractApiKey(request);
  if (!key) {
    return unauthorized(
      "Provide Authorization: Bearer <api_key> or X-API-Key header",
    );
  }
  if (!isValidKeyFormat(key)) {
    return unauthorized(
      "API key must be at least 24 printable ASCII characters",
    );
  }
  const identity = await identityFromKey(key);
  await ensureKeyRegistered(env.PASTES, identity);
  return identity;
}

function asString(v: unknown, field: string, opts?: { max?: number; required?: boolean }): string | undefined {
  if (v === undefined || v === null) {
    if (opts?.required) throw new Error(`Missing required field: ${field}`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  if (opts?.max && v.length > opts.max) throw new Error(`${field} too long`);
  return v;
}

function asNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${field} must be a number`);
  }
  return v;
}

function buildTools(
  env: Env,
  identity: AgentIdentity,
): Record<string, { def: McpToolDef; handler: McpToolHandler }> {
  const tool = (
    def: McpToolDef,
    handler: McpToolHandler,
  ): { def: McpToolDef; handler: McpToolHandler } => ({ def, handler });

  return {
    create_paste: tool(
      {
        name: "create_paste",
        description:
          "Create a new paste owned by the calling agent's API key. Returns the paste id and metadata.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Paste body text" },
            title: { type: "string", description: "Optional title" },
            language: {
              type: "string",
              description: "Optional language hint (e.g. typescript, markdown)",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const content = asString(args.content, "content", {
          required: true,
          max: 500_000,
        })!;
        if (!content.length) throw new Error("content must not be empty");
        const title = asString(args.title, "title", { max: 200 });
        const language = asString(args.language, "language", { max: 64 });
        const paste = await createPaste(env.PASTES, identity.keyHash, {
          content,
          title,
          language,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(publicPaste(paste), null, 2) },
          ],
        };
      },
    ),

    get_paste: tool(
      {
        name: "get_paste",
        description:
          "Fetch a paste by id. Only pastes owned by this API key are visible.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Paste id" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 64 })!;
        const paste = await getPaste(env.PASTES, identity.keyHash, id);
        if (!paste) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "not_found", id }, null, 2),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(publicPaste(paste), null, 2) },
          ],
        };
      },
    ),

    list_pastes: tool(
      {
        name: "list_pastes",
        description:
          "List pastes owned by this API key (newest first). Returns summaries without full content.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Max items (default 50, max 100)",
              minimum: 1,
              maximum: 100,
            },
          },
          additionalProperties: false,
        },
      },
      async (args) => {
        const limit = asNumber(args.limit, "limit") ?? 50;
        const items = await listPastes(env.PASTES, identity.keyHash, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  fingerprint: identity.fingerprint,
                  count: items.length,
                  pastes: items,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),

    delete_paste: tool(
      {
        name: "delete_paste",
        description: "Delete a paste owned by this API key.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Paste id" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 64 })!;
        const deleted = await deletePaste(env.PASTES, identity.keyHash, id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                deleted
                  ? { ok: true, id }
                  : { ok: false, error: "not_found", id },
                null,
                2,
              ),
            },
          ],
          isError: !deleted,
        };
      },
    ),

    whoami: tool(
      {
        name: "whoami",
        description:
          "Show the authenticated API key fingerprint (not the secret) for this MCP session.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                fingerprint: identity.fingerprint,
                note: "Pastes are scoped to this API key. Other keys cannot read them.",
              },
              null,
              2,
            ),
          },
        ],
      }),
    ),
  };
}

async function handleMcp(
  request: Request,
  env: Env,
  identity: AgentIdentity,
): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed (stateless MCP)", {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "content-type, authorization, x-api-key, mcp-protocol-version, accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const tools = buildTools(env, identity);
  const serverInfo = { name: "pastebin-mcp", version: "1.0.0" };
  const messages = parseJsonRpcMessages(body);
  const responses = [];

  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push({
        jsonrpc: "2.0",
        id: (msg as { id?: string | number | null })?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      continue;
    }
    const response = await handleMcpRpc(msg, tools, serverInfo);
    if (response) responses.push(response);
  }

  // Notifications-only → 202 Accepted with empty body (MCP Streamable HTTP)
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleCreateKey(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }

  let label: string | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { label?: unknown };
      if (typeof body.label === "string" && body.label.trim()) {
        label = body.label.trim().slice(0, 80);
      }
    } catch {
      // empty body ok
    }
  }

  const apiKey = generateApiKey();
  const identity = await identityFromKey(apiKey);
  const record = await ensureKeyRegistered(env.PASTES, identity, label);

  return json(
    {
      api_key: apiKey,
      fingerprint: record.fingerprint,
      created_at: record.createdAt,
      label: record.label ?? null,
      usage: {
        header: `Authorization: Bearer ${apiKey}`,
        mcp_url: new URL("/mcp", request.url).toString(),
      },
      warning:
        "Store this API key now — it is shown only once. The server stores only a hash.",
    },
    201,
  );
}

function handleRoot(request: Request): Response {
  return json({
    name: "pastebin-mcp",
    version: "1.0.0",
    mcp: new URL("/mcp", request.url).toString(),
    auth: {
      type: "bearer",
      headers: ["Authorization: Bearer <api_key>", "X-API-Key: <api_key>"],
      mint_key: "POST /v1/keys",
      note: "Each agent supplies its own API key. No shared Worker secret for client auth.",
    },
    tools: [
      "create_paste",
      "get_paste",
      "list_pastes",
      "delete_paste",
      "whoami",
    ],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return handleRoot(request);
    }

    if (url.pathname === "/v1/keys") {
      return handleCreateKey(request, env);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      return handleMcp(request, env, auth);
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;
