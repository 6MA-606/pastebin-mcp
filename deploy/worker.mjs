var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/auth.ts
var MIN_KEY_LENGTH = 24;
function extractApiKey(request) {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = request.headers.get("X-API-Key")?.trim();
  return apiKey || null;
}
__name(extractApiKey, "extractApiKey");
function isValidKeyFormat(key) {
  return key.length >= MIN_KEY_LENGTH && /^[\x21-\x7E]+$/.test(key);
}
__name(isValidKeyFormat, "isValidKeyFormat");
async function hashApiKey(key) {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashApiKey, "hashApiKey");
async function identityFromKey(key) {
  const keyHash = await hashApiKey(key);
  return {
    keyHash,
    fingerprint: keyHash.slice(0, 12)
  };
}
__name(identityFromKey, "identityFromKey");
function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(generateApiKey, "generateApiKey");
async function ensureKeyRegistered(kv, identity, label) {
  const keyPath = `key:${identity.keyHash}`;
  const existing = await kv.get(keyPath, "json");
  if (existing && typeof existing === "object") {
    return existing;
  }
  const record = {
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    fingerprint: identity.fingerprint,
    ...label ? { label } : {}
  };
  await kv.put(keyPath, JSON.stringify(record));
  return record;
}
__name(ensureKeyRegistered, "ensureKeyRegistered");

// src/mcp-rpc.ts
var SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26"
];
function negotiateProtocolVersion(requested) {
  if (typeof requested === "string") {
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
      return requested;
    }
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}
__name(negotiateProtocolVersion, "negotiateProtocolVersion");
function parseJsonRpcMessages(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") return [body];
  throw new Error("Invalid JSON-RPC body");
}
__name(parseJsonRpcMessages, "parseJsonRpcMessages");
function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
__name(jsonRpcResult, "jsonRpcResult");
function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...data !== void 0 ? { data } : {} }
  };
}
__name(jsonRpcError, "jsonRpcError");
async function handleMcpRpc(message, tools, serverInfo) {
  const { method, id } = message;
  const isNotification = id === void 0;
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null;
  }
  if (isNotification) return null;
  const reqId = id ?? null;
  switch (method) {
    case "initialize": {
      const params = message.params ?? {};
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      return jsonRpcResult(reqId, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo
      });
    }
    case "ping":
      return jsonRpcResult(reqId, {});
    case "tools/list":
      return jsonRpcResult(reqId, {
        tools: Object.values(tools).map((t) => t.def)
      });
    case "tools/call": {
      const params = message.params ?? {};
      const name = params.name;
      if (!name || !tools[name]) {
        return jsonRpcError(
          reqId,
          -32601,
          `Unknown tool: ${name ?? "(missing)"}`
        );
      }
      try {
        const result = await tools[name].handler(params.arguments ?? {});
        return jsonRpcResult(reqId, result);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(reqId, {
          content: [{ type: "text", text }],
          isError: true
        });
      }
    }
    default:
      return jsonRpcError(reqId, -32601, `Method not found: ${method}`);
  }
}
__name(handleMcpRpc, "handleMcpRpc");
function wantsSseResponse(request) {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (!accept) return false;
  const wantsJson = accept.includes("application/json");
  const wantsSse = accept.includes("text/event-stream");
  return wantsSse && !wantsJson;
}
__name(wantsSseResponse, "wantsSseResponse");
function mcpJsonResponse(payload, request, status = 200) {
  const cors = corsHeaders(request);
  if (wantsSseResponse(request)) {
    const data = `event: message
data: ${JSON.stringify(payload)}

`;
    return new Response(data, {
      status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...cors
      }
    });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...cors
    }
  });
}
__name(mcpJsonResponse, "mcpJsonResponse");
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    // Echo concrete Origin when present (credentials-friendly); else *
    "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-API-Key, Mcp-Protocol-Version, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");

// src/pastes.ts
var PASTE_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function generatePasteId(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const b of bytes) {
    id += PASTE_ID_ALPHABET[b % PASTE_ID_ALPHABET.length];
  }
  return id;
}
__name(generatePasteId, "generatePasteId");
function pasteKey(ownerHash, pasteId) {
  return `paste:${ownerHash}:${pasteId}`;
}
__name(pasteKey, "pasteKey");
function indexKey(ownerHash) {
  return `index:${ownerHash}`;
}
__name(indexKey, "indexKey");
async function createPaste(kv, ownerHash, input) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = generatePasteId();
  const paste = {
    id,
    content: input.content,
    title: input.title,
    language: input.language,
    createdAt: now,
    updatedAt: now,
    ownerHash
  };
  await kv.put(pasteKey(ownerHash, id), JSON.stringify(paste));
  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? indexRaw : [];
  index.unshift(id);
  const trimmed = index.slice(0, 500);
  await kv.put(indexKey(ownerHash), JSON.stringify(trimmed));
  return paste;
}
__name(createPaste, "createPaste");
async function getPaste(kv, ownerHash, pasteId) {
  const raw = await kv.get(pasteKey(ownerHash, pasteId), "json");
  if (!raw || typeof raw !== "object") return null;
  const paste = raw;
  if (paste.ownerHash !== ownerHash) return null;
  return paste;
}
__name(getPaste, "getPaste");
async function listPastes(kv, ownerHash, limit = 50) {
  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? indexRaw : [];
  const ids = index.slice(0, Math.min(Math.max(limit, 1), 100));
  const summaries = [];
  for (const id of ids) {
    const paste = await getPaste(kv, ownerHash, id);
    if (!paste) continue;
    summaries.push({
      id: paste.id,
      title: paste.title,
      language: paste.language,
      createdAt: paste.createdAt,
      updatedAt: paste.updatedAt,
      size: paste.content.length
    });
  }
  return summaries;
}
__name(listPastes, "listPastes");
async function deletePaste(kv, ownerHash, pasteId) {
  const existing = await getPaste(kv, ownerHash, pasteId);
  if (!existing) return false;
  await kv.delete(pasteKey(ownerHash, pasteId));
  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? indexRaw : [];
  const next = index.filter((id) => id !== pasteId);
  await kv.put(indexKey(ownerHash), JSON.stringify(next));
  return true;
}
__name(deletePaste, "deletePaste");
function publicPaste(paste) {
  return {
    id: paste.id,
    content: paste.content,
    title: paste.title ?? null,
    language: paste.language ?? null,
    createdAt: paste.createdAt,
    updatedAt: paste.updatedAt
  };
}
__name(publicPaste, "publicPaste");

// src/index.ts
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}
__name(json, "json");
function unauthorized(request, message = "Missing or invalid API key") {
  return json(
    {
      error: "unauthorized",
      message,
      hint: "Pass Authorization: Bearer <api_key> (or X-API-Key). Mint a key with POST /v1/keys."
    },
    401,
    corsHeaders(request)
  );
}
__name(unauthorized, "unauthorized");
async function authenticate(request, env) {
  const key = extractApiKey(request);
  if (!key) {
    return unauthorized(
      request,
      "Provide Authorization: Bearer <api_key> or X-API-Key header"
    );
  }
  if (!isValidKeyFormat(key)) {
    return unauthorized(
      request,
      "API key must be at least 24 printable ASCII characters"
    );
  }
  const identity = await identityFromKey(key);
  await ensureKeyRegistered(env.PASTES, identity);
  return identity;
}
__name(authenticate, "authenticate");
function asString(v, field, opts) {
  if (v === void 0 || v === null) {
    if (opts?.required) throw new Error(`Missing required field: ${field}`);
    return void 0;
  }
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  if (opts?.max && v.length > opts.max) throw new Error(`${field} too long`);
  return v;
}
__name(asString, "asString");
function asNumber(v, field) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${field} must be a number`);
  }
  return v;
}
__name(asNumber, "asNumber");
function buildTools(env, identity) {
  const tool = /* @__PURE__ */ __name((def, handler) => ({ def, handler }), "tool");
  return {
    create_paste: tool(
      {
        name: "create_paste",
        description: "Create a new paste owned by the calling agent's API key. Returns the paste id and metadata.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Paste body text" },
            title: { type: "string", description: "Optional title" },
            language: {
              type: "string",
              description: "Optional language hint (e.g. typescript, markdown)"
            }
          },
          required: ["content"],
          additionalProperties: false
        }
      },
      async (args) => {
        const content = asString(args.content, "content", {
          required: true,
          max: 5e5
        });
        if (!content.length) throw new Error("content must not be empty");
        const title = asString(args.title, "title", { max: 200 });
        const language = asString(args.language, "language", { max: 64 });
        const paste = await createPaste(env.PASTES, identity.keyHash, {
          content,
          title,
          language
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(publicPaste(paste), null, 2) }
          ]
        };
      }
    ),
    get_paste: tool(
      {
        name: "get_paste",
        description: "Fetch a paste by id. Only pastes owned by this API key are visible.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Paste id" }
          },
          required: ["id"],
          additionalProperties: false
        }
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 64 });
        const paste = await getPaste(env.PASTES, identity.keyHash, id);
        if (!paste) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "not_found", id }, null, 2)
              }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(publicPaste(paste), null, 2) }
          ]
        };
      }
    ),
    list_pastes: tool(
      {
        name: "list_pastes",
        description: "List pastes owned by this API key (newest first). Returns summaries without full content.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Max items (default 50, max 100)",
              minimum: 1,
              maximum: 100
            }
          },
          additionalProperties: false
        }
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
                  pastes: items
                },
                null,
                2
              )
            }
          ]
        };
      }
    ),
    delete_paste: tool(
      {
        name: "delete_paste",
        description: "Delete a paste owned by this API key.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Paste id" }
          },
          required: ["id"],
          additionalProperties: false
        }
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 64 });
        const deleted = await deletePaste(env.PASTES, identity.keyHash, id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                deleted ? { ok: true, id } : { ok: false, error: "not_found", id },
                null,
                2
              )
            }
          ],
          isError: !deleted
        };
      }
    ),
    whoami: tool(
      {
        name: "whoami",
        description: "Show the authenticated API key fingerprint (not the secret) for this MCP session.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                fingerprint: identity.fingerprint,
                note: "Pastes are scoped to this API key. Other keys cannot read them."
              },
              null,
              2
            )
          }
        ]
      })
    )
  };
}
__name(buildTools, "buildTools");
function handleCorsPreflight(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}
__name(handleCorsPreflight, "handleCorsPreflight");
async function handleMcp(request, env, identity) {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed (stateless MCP)", {
      status: 405,
      headers: {
        Allow: "POST, OPTIONS",
        ...corsHeaders(request)
      }
    });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...corsHeaders(request) }
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, corsHeaders(request));
  }
  const tools = buildTools(env, identity);
  const serverInfo = { name: "pastebin-mcp", version: "1.0.1" };
  const messages = parseJsonRpcMessages(body);
  const responses = [];
  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      responses.push({
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: -32600, message: "Invalid Request" }
      });
      continue;
    }
    const response = await handleMcpRpc(msg, tools, serverInfo);
    if (response) responses.push(response);
  }
  if (responses.length === 0) {
    return new Response(null, {
      status: 202,
      headers: corsHeaders(request)
    });
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return mcpJsonResponse(payload, request, 200);
}
__name(handleMcp, "handleMcp");
async function handleCreateKey(request, env) {
  if (request.method === "OPTIONS") return handleCorsPreflight(request);
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, {
      Allow: "POST",
      ...corsHeaders(request)
    });
  }
  let label;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await request.json();
      if (typeof body.label === "string" && body.label.trim()) {
        label = body.label.trim().slice(0, 80);
      }
    } catch {
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
        mcp_url: new URL("/mcp", request.url).toString()
      },
      warning: "Store this API key now \u2014 it is shown only once. The server stores only a hash."
    },
    201,
    corsHeaders(request)
  );
}
__name(handleCreateKey, "handleCreateKey");
function handleRoot(request) {
  return json(
    {
      name: "pastebin-mcp",
      version: "1.0.1",
      mcp: new URL("/mcp", request.url).toString(),
      auth: {
        type: "bearer",
        headers: ["Authorization: Bearer <api_key>", "X-API-Key: <api_key>"],
        mint_key: "POST /v1/keys",
        note: "Each agent supplies its own API key. No shared Worker secret for client auth. No OAuth."
      },
      tools: [
        "create_paste",
        "get_paste",
        "list_pastes",
        "delete_paste",
        "whoami"
      ]
    },
    200,
    corsHeaders(request)
  );
}
__name(handleRoot, "handleRoot");
function isOauthDiscoveryPath(pathname) {
  return pathname.startsWith("/.well-known/") || pathname === "/register" || pathname.endsWith("/.well-known/openid-configuration") || pathname.includes("/.well-known/");
}
__name(isOauthDiscoveryPath, "isOauthDiscoveryPath");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (isOauthDiscoveryPath(pathname)) {
      return json(
        { error: "not_found", path: pathname },
        404,
        corsHeaders(request)
      );
    }
    if (pathname === "/" || pathname === "") {
      if (request.method === "OPTIONS") return handleCorsPreflight(request);
      return handleRoot(request);
    }
    if (pathname === "/v1/keys") {
      return handleCreateKey(request, env);
    }
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") {
        return handleCorsPreflight(request);
      }
      const auth = await authenticate(request, env);
      if (auth instanceof Response) return auth;
      return handleMcp(request, env, auth);
    }
    return json(
      { error: "not_found", path: pathname },
      404,
      corsHeaders(request)
    );
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
