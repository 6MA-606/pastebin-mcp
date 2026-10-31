import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ensureKeyRegistered,
  extractApiKey,
  generateApiKey,
  identityFromKey,
  isValidKeyFormat,
  type AgentIdentity,
} from "./auth";
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

type AuthProps = {
  identity: AgentIdentity;
};

/** AsyncLocal-style bag so tools can read the current request's identity + env. */
let current: { env: Env; identity: AgentIdentity } | null = null;

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
): Promise<AuthProps | Response> {
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
  return { identity };
}

function requireCtx() {
  if (!current) {
    throw new Error(
      "Unauthenticated — set Authorization: Bearer <api_key> on the MCP connection",
    );
  }
  return current;
}

function createPastebinServer() {
  const server = new McpServer({
    name: "pastebin-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "create_paste",
    {
      description:
        "Create a new paste owned by the calling agent's API key. Returns the paste id and metadata.",
      inputSchema: {
        content: z.string().min(1).max(500_000).describe("Paste body text"),
        title: z.string().max(200).optional().describe("Optional title"),
        language: z
          .string()
          .max(64)
          .optional()
          .describe("Optional language hint (e.g. typescript, markdown)"),
      },
    },
    async ({ content, title, language }) => {
      const { env, identity } = requireCtx();
      const paste = await createPaste(env.PASTES, identity.keyHash, {
        content,
        title,
        language,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(publicPaste(paste), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_paste",
    {
      description:
        "Fetch a paste by id. Only pastes owned by this API key are visible.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Paste id"),
      },
    },
    async ({ id }) => {
      const { env, identity } = requireCtx();
      const paste = await getPaste(env.PASTES, identity.keyHash, id);
      if (!paste) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not_found", id }, null, 2),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(publicPaste(paste), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_pastes",
    {
      description:
        "List pastes owned by this API key (newest first). Returns summaries without full content.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max items (default 50)"),
      },
    },
    async ({ limit }) => {
      const { env, identity } = requireCtx();
      const items = await listPastes(env.PASTES, identity.keyHash, limit ?? 50);
      return {
        content: [
          {
            type: "text" as const,
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
  );

  server.registerTool(
    "delete_paste",
    {
      description: "Delete a paste owned by this API key.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Paste id"),
      },
    },
    async ({ id }) => {
      const { env, identity } = requireCtx();
      const deleted = await deletePaste(env.PASTES, identity.keyHash, id);
      return {
        content: [
          {
            type: "text" as const,
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
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Show the authenticated API key fingerprint (not the secret) for this MCP session.",
    },
    async () => {
      const { identity } = requireCtx();
      return {
        content: [
          {
            type: "text" as const,
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
      };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createPastebinServer);

async function handleCreateKey(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, {
      Allow: "POST",
    });
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
      // empty body is fine
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
  const mcpUrl = new URL("/mcp", request.url).toString();
  return json({
    name: "pastebin-mcp",
    version: "1.0.0",
    mcp: mcpUrl,
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
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
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

      current = { env, identity: auth.identity };
      try {
        return await mcpHandler.fetch(request, {
          authInfo: {
            token: "redacted",
            clientId: auth.identity.fingerprint,
            scopes: ["pastebin"],
          },
        });
      } finally {
        current = null;
      }
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;
