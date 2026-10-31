import { credsFromRequest, type PastebinCreds } from "./auth";
import {
  corsHeaders,
  handleMcpRpc,
  mcpJsonResponse,
  parseJsonRpcMessages,
  type McpToolDef,
  type McpToolHandler,
} from "./mcp-rpc";
import {
  createPaste,
  deletePaste,
  getPaste,
  listPastes,
  loginUser,
} from "./pastebin-api";

export interface Env {
  // No shared Pastebin secret — agents supply api_dev_key on each request.
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

/** Bare 401 — no WWW-Authenticate (avoids Cursor OAuth probing). */
function unauthorized(request: Request, message: string): Response {
  return json(
    {
      error: "unauthorized",
      message,
      hint: "Pass Authorization: Bearer <pastebin_api_dev_key> (or X-API-Key). Get a key at https://pastebin.com/doc_api after signing in. Optional: X-Pastebin-User-Key for member list/delete/private.",
    },
    401,
    corsHeaders(request),
  );
}

function authenticate(request: Request): PastebinCreds | Response {
  const creds = credsFromRequest(request);
  if (!creds) {
    return unauthorized(
      request,
      "Provide your Pastebin Developer API Key via Authorization: Bearer … or X-API-Key",
    );
  }
  return creds;
}

function asString(
  v: unknown,
  field: string,
  opts?: { max?: number; required?: boolean },
): string | undefined {
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
  creds: PastebinCreds,
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
          "Create a paste on pastebin.com using the caller's api_dev_key. Returns the pastebin.com URL and id.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Paste body text" },
            title: { type: "string", description: "Optional title / filename" },
            language: {
              type: "string",
              description:
                "Optional Pastebin format key (e.g. javascript, python, text)",
            },
            visibility: {
              type: "integer",
              description: "0=public, 1=unlisted (default), 2=private (needs user key)",
              enum: [0, 1, 2],
            },
            expire: {
              type: "string",
              description: "Optional expiry: N, 10M, 1H, 1D, 1W, 2W, 1M, 6M, 1Y",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const content = asString(args.content, "content", {
          required: true,
          max: 512_000,
        })!;
        if (!content.length) throw new Error("content must not be empty");
        const title = asString(args.title, "title", { max: 100 });
        const language = asString(args.language, "language", { max: 64 });
        const expire = asString(args.expire, "expire", { max: 8 });
        const visNum = asNumber(args.visibility, "visibility");
        const visibility =
          visNum === 0 || visNum === 1 || visNum === 2 ? visNum : undefined;

        const paste = await createPaste(creds, {
          content,
          title,
          language,
          expire,
          visibility,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { id: paste.id, url: paste.url, site: "pastebin.com" },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),

    get_paste: tool(
      {
        name: "get_paste",
        description:
          "Fetch a paste from pastebin.com by id or URL (uses /raw/ or authenticated api_raw for private).",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Paste id or full pastebin.com URL",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 200 })!;
        const paste = await getPaste(creds, id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(paste, null, 2),
            },
          ],
        };
      },
    ),

    list_pastes: tool(
      {
        name: "list_pastes",
        description:
          "List pastes for the Pastebin member account. Requires X-Pastebin-User-Key header.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Max items (default 50, max 1000)",
              minimum: 1,
              maximum: 1000,
            },
          },
          additionalProperties: false,
        },
      },
      async (args) => {
        const limit = asNumber(args.limit, "limit") ?? 50;
        const pastes = await listPastes(creds, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: pastes.length, pastes }, null, 2),
            },
          ],
        };
      },
    ),

    delete_paste: tool(
      {
        name: "delete_paste",
        description:
          "Delete a paste owned by the member account. Requires X-Pastebin-User-Key.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Paste id or pastebin.com URL",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 200 })!;
        const result = await deletePaste(creds, id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    ),

    login: tool(
      {
        name: "login",
        description:
          "Exchange Pastebin username/password for an api_user_key (session). Store it as X-Pastebin-User-Key on later requests. Do not log the password.",
        inputSchema: {
          type: "object",
          properties: {
            username: { type: "string" },
            password: { type: "string" },
          },
          required: ["username", "password"],
          additionalProperties: false,
        },
      },
      async (args) => {
        const username = asString(args.username, "username", {
          required: true,
          max: 64,
        })!;
        const password = asString(args.password, "password", {
          required: true,
          max: 128,
        })!;
        const userKey = await loginUser(creds.devKey, username, password);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  api_user_key: userKey,
                  usage:
                    "Send header X-Pastebin-User-Key with this value for list/delete/private pastes.",
                  warning:
                    "Treat api_user_key like a password. Prefer setting it in MCP client headers, not chat logs.",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),

    whoami: tool(
      {
        name: "whoami",
        description:
          "Show whether a Pastebin user key is attached (never returns the secret keys).",
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
                backend: "pastebin.com",
                has_dev_key: true,
                has_user_key: Boolean(creds.userKey),
                note: "api_dev_key comes from Authorization / X-API-Key. Optional api_user_key from X-Pastebin-User-Key.",
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

function handleCorsPreflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

async function handleMcp(
  request: Request,
  creds: PastebinCreds,
): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed (stateless MCP)", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...corsHeaders(request) },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...corsHeaders(request) },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, corsHeaders(request));
  }

  const tools = buildTools(creds);
  const serverInfo = { name: "pastebin-mcp", version: "2.0.0" };
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

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: corsHeaders(request) });
  }

  const payload = Array.isArray(body) ? responses : responses[0];
  return mcpJsonResponse(payload, request, 200);
}

function handleRoot(request: Request): Response {
  return json(
    {
      name: "pastebin-mcp",
      version: "2.0.0",
      backend: "https://pastebin.com",
      mcp: new URL("/mcp", request.url).toString(),
      auth: {
        type: "pastebin_api_dev_key",
        headers: [
          "Authorization: Bearer <pastebin_api_dev_key>",
          "X-API-Key: <pastebin_api_dev_key>",
          "X-Pastebin-User-Key: <api_user_key> (optional)",
        ],
        get_dev_key: "https://pastebin.com/doc_api (sign in)",
        note: "Each agent supplies its own Pastebin Developer API Key. Nothing is baked into the Worker.",
      },
      tools: [
        "create_paste",
        "get_paste",
        "list_pastes",
        "delete_paste",
        "login",
        "whoami",
      ],
    },
    200,
    corsHeaders(request),
  );
}

function isOauthDiscoveryPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/") ||
    pathname === "/register" ||
    pathname.includes("/.well-known/")
  );
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (isOauthDiscoveryPath(pathname)) {
      return json(
        { error: "not_found", path: pathname },
        404,
        corsHeaders(request),
      );
    }

    if (pathname === "/" || pathname === "") {
      if (request.method === "OPTIONS") return handleCorsPreflight(request);
      return handleRoot(request);
    }

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") return handleCorsPreflight(request);
      const auth = authenticate(request);
      if (auth instanceof Response) return auth;
      return handleMcp(request, auth);
    }

    return json(
      { error: "not_found", path: pathname },
      404,
      corsHeaders(request),
    );
  },
} satisfies ExportedHandler<Env>;
