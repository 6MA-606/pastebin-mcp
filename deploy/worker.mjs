var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/auth.ts
var MIN_DEV_KEY_LENGTH = 8;
function extractDevKey(request) {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = request.headers.get("X-API-Key")?.trim();
  return apiKey || null;
}
__name(extractDevKey, "extractDevKey");
function extractUserKey(request) {
  const h = request.headers.get("X-Pastebin-User-Key")?.trim() || request.headers.get("X-API-User-Key")?.trim();
  return h || void 0;
}
__name(extractUserKey, "extractUserKey");
function isValidDevKeyFormat(key) {
  return key.length >= MIN_DEV_KEY_LENGTH && /^[\x21-\x7E]+$/.test(key);
}
__name(isValidDevKeyFormat, "isValidDevKeyFormat");
function credsFromRequest(request) {
  const devKey = extractDevKey(request);
  if (!devKey || !isValidDevKeyFormat(devKey)) return null;
  return {
    devKey,
    userKey: extractUserKey(request)
  };
}
__name(credsFromRequest, "credsFromRequest");

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
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-API-Key, X-Pastebin-User-Key, X-API-User-Key, Mcp-Protocol-Version, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");

// src/pastebin-api.ts
var API_POST = "https://pastebin.com/api/api_post.php";
var API_RAW = "https://pastebin.com/api/api_raw.php";
var RAW_PUBLIC = "https://pastebin.com/raw/";
function formBody(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== void 0 && v !== "") p.set(k, v);
  }
  return p.toString();
}
__name(formBody, "formBody");
async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields)
  });
  const text = await res.text();
  return text.trim();
}
__name(postForm, "postForm");
function isPastebinError(text) {
  return text.toLowerCase().startsWith("bad api request");
}
__name(isPastebinError, "isPastebinError");
function pasteKeyFromUrlOrId(idOrUrl) {
  const trimmed = idOrUrl.trim();
  const m = /pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)/i.exec(trimmed);
  if (m) return m[1];
  return trimmed.replace(/^\/+/, "");
}
__name(pasteKeyFromUrlOrId, "pasteKeyFromUrlOrId");
async function createPaste(creds, input) {
  const visibility = input.visibility ?? 1;
  if (visibility === 2 && !creds.userKey) {
    throw new Error(
      "Private pastes require X-Pastebin-User-Key (api_user_key from Pastebin login API)"
    );
  }
  const fields = {
    api_dev_key: creds.devKey,
    api_option: "paste",
    api_paste_code: input.content,
    api_paste_private: String(visibility)
  };
  if (creds.userKey) fields.api_user_key = creds.userKey;
  if (input.title) fields.api_paste_name = input.title;
  if (input.language) fields.api_paste_format = input.language;
  if (input.expire) fields.api_paste_expire_date = input.expire;
  const text = await postForm(API_POST, fields);
  if (isPastebinError(text) || !text.includes("pastebin.com/")) {
    throw new Error(text || "Pastebin create failed");
  }
  const id = pasteKeyFromUrlOrId(text);
  return { url: text, id };
}
__name(createPaste, "createPaste");
async function getPaste(creds, idOrUrl) {
  const id = pasteKeyFromUrlOrId(idOrUrl);
  if (creds.userKey) {
    const text = await postForm(API_RAW, {
      api_dev_key: creds.devKey,
      api_user_key: creds.userKey,
      api_paste_key: id,
      api_option: "show_paste"
    });
    if (!isPastebinError(text)) {
      return {
        id,
        url: `https://pastebin.com/${id}`,
        content: text,
        source: "api_raw"
      };
    }
  }
  const res = await fetch(`${RAW_PUBLIC}${id}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch paste ${id}: HTTP ${res.status}${creds.userKey ? "" : " (private pastes need X-Pastebin-User-Key)"}`
    );
  }
  const content = await res.text();
  return {
    id,
    url: `https://pastebin.com/${id}`,
    content,
    source: "raw"
  };
}
__name(getPaste, "getPaste");
async function listPastes(creds, limit = 50) {
  if (!creds.userKey) {
    throw new Error(
      "list_pastes requires X-Pastebin-User-Key (api_user_key). Guest keys cannot list pastes."
    );
  }
  const text = await postForm(API_POST, {
    api_dev_key: creds.devKey,
    api_user_key: creds.userKey,
    api_option: "list",
    api_results_limit: String(Math.min(Math.max(limit, 1), 1e3))
  });
  if (isPastebinError(text)) throw new Error(text);
  if (!text || text === "No pastes found.") return [];
  const items = [];
  const blocks = text.match(/<paste>[\s\S]*?<\/paste>/g) ?? [];
  for (const block of blocks) {
    const get = /* @__PURE__ */ __name((tag) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return m ? m[1].trim() : "";
    }, "get");
    items.push({
      paste_key: get("paste_key"),
      paste_title: get("paste_title"),
      paste_date: get("paste_date"),
      paste_size: get("paste_size"),
      paste_private: get("paste_private"),
      paste_format_short: get("paste_format_short"),
      paste_url: get("paste_url"),
      paste_hits: get("paste_hits") || void 0
    });
  }
  return items;
}
__name(listPastes, "listPastes");
async function deletePaste(creds, idOrUrl) {
  if (!creds.userKey) {
    throw new Error(
      "delete_paste requires X-Pastebin-User-Key (api_user_key)."
    );
  }
  const id = pasteKeyFromUrlOrId(idOrUrl);
  const text = await postForm(API_POST, {
    api_dev_key: creds.devKey,
    api_user_key: creds.userKey,
    api_paste_key: id,
    api_option: "delete"
  });
  if (isPastebinError(text) && !/deleted/i.test(text)) {
    throw new Error(text);
  }
  return { ok: true, id };
}
__name(deletePaste, "deletePaste");
async function loginUser(devKey, username, password) {
  const text = await postForm("https://pastebin.com/api/api_login.php", {
    api_dev_key: devKey,
    api_user_name: username,
    api_user_password: password
  });
  if (isPastebinError(text) || text.length < 8) {
    throw new Error(text || "Pastebin login failed");
  }
  return text;
}
__name(loginUser, "loginUser");

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
function unauthorized(request, message) {
  return json(
    {
      error: "unauthorized",
      message,
      hint: "Pass Authorization: Bearer <pastebin_api_dev_key> (or X-API-Key). Get a key at https://pastebin.com/doc_api after signing in. Optional: X-Pastebin-User-Key for member list/delete/private."
    },
    401,
    corsHeaders(request)
  );
}
__name(unauthorized, "unauthorized");
function authenticate(request) {
  const creds = credsFromRequest(request);
  if (!creds) {
    return unauthorized(
      request,
      "Provide your Pastebin Developer API Key via Authorization: Bearer \u2026 or X-API-Key"
    );
  }
  return creds;
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
function buildTools(creds) {
  const tool = /* @__PURE__ */ __name((def, handler) => ({ def, handler }), "tool");
  return {
    create_paste: tool(
      {
        name: "create_paste",
        description: "Create a paste on pastebin.com using the caller's api_dev_key. Returns the pastebin.com URL and id.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Paste body text" },
            title: { type: "string", description: "Optional title / filename" },
            language: {
              type: "string",
              description: "Optional Pastebin format key (e.g. javascript, python, text)"
            },
            visibility: {
              type: "integer",
              description: "0=public, 1=unlisted (default), 2=private (needs user key)",
              enum: [0, 1, 2]
            },
            expire: {
              type: "string",
              description: "Optional expiry: N, 10M, 1H, 1D, 1W, 2W, 1M, 6M, 1Y"
            }
          },
          required: ["content"],
          additionalProperties: false
        }
      },
      async (args) => {
        const content = asString(args.content, "content", {
          required: true,
          max: 512e3
        });
        if (!content.length) throw new Error("content must not be empty");
        const title = asString(args.title, "title", { max: 100 });
        const language = asString(args.language, "language", { max: 64 });
        const expire = asString(args.expire, "expire", { max: 8 });
        const visNum = asNumber(args.visibility, "visibility");
        const visibility = visNum === 0 || visNum === 1 || visNum === 2 ? visNum : void 0;
        const paste = await createPaste(creds, {
          content,
          title,
          language,
          expire,
          visibility
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { id: paste.id, url: paste.url, site: "pastebin.com" },
                null,
                2
              )
            }
          ]
        };
      }
    ),
    get_paste: tool(
      {
        name: "get_paste",
        description: "Fetch a paste from pastebin.com by id or URL (uses /raw/ or authenticated api_raw for private).",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Paste id or full pastebin.com URL"
            }
          },
          required: ["id"],
          additionalProperties: false
        }
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 200 });
        const paste = await getPaste(creds, id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(paste, null, 2)
            }
          ]
        };
      }
    ),
    list_pastes: tool(
      {
        name: "list_pastes",
        description: "List pastes for the Pastebin member account. Requires X-Pastebin-User-Key header.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Max items (default 50, max 1000)",
              minimum: 1,
              maximum: 1e3
            }
          },
          additionalProperties: false
        }
      },
      async (args) => {
        const limit = asNumber(args.limit, "limit") ?? 50;
        const pastes = await listPastes(creds, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: pastes.length, pastes }, null, 2)
            }
          ]
        };
      }
    ),
    delete_paste: tool(
      {
        name: "delete_paste",
        description: "Delete a paste owned by the member account. Requires X-Pastebin-User-Key.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Paste id or pastebin.com URL"
            }
          },
          required: ["id"],
          additionalProperties: false
        }
      },
      async (args) => {
        const id = asString(args.id, "id", { required: true, max: 200 });
        const result = await deletePaste(creds, id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    ),
    login: tool(
      {
        name: "login",
        description: "Exchange Pastebin username/password for an api_user_key (session). Store it as X-Pastebin-User-Key on later requests. Do not log the password.",
        inputSchema: {
          type: "object",
          properties: {
            username: { type: "string" },
            password: { type: "string" }
          },
          required: ["username", "password"],
          additionalProperties: false
        }
      },
      async (args) => {
        const username = asString(args.username, "username", {
          required: true,
          max: 64
        });
        const password = asString(args.password, "password", {
          required: true,
          max: 128
        });
        const userKey = await loginUser(creds.devKey, username, password);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  api_user_key: userKey,
                  usage: "Send header X-Pastebin-User-Key with this value for list/delete/private pastes.",
                  warning: "Treat api_user_key like a password. Prefer setting it in MCP client headers, not chat logs."
                },
                null,
                2
              )
            }
          ]
        };
      }
    ),
    whoami: tool(
      {
        name: "whoami",
        description: "Show whether a Pastebin user key is attached (never returns the secret keys).",
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
                backend: "pastebin.com",
                has_dev_key: true,
                has_user_key: Boolean(creds.userKey),
                note: "api_dev_key comes from Authorization / X-API-Key. Optional api_user_key from X-Pastebin-User-Key."
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
async function handleMcp(request, creds) {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed (stateless MCP)", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...corsHeaders(request) }
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
  const tools = buildTools(creds);
  const serverInfo = { name: "pastebin-mcp", version: "2.0.0" };
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
    return new Response(null, { status: 202, headers: corsHeaders(request) });
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return mcpJsonResponse(payload, request, 200);
}
__name(handleMcp, "handleMcp");
function handleRoot(request) {
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
          "X-Pastebin-User-Key: <api_user_key> (optional)"
        ],
        get_dev_key: "https://pastebin.com/doc_api (sign in)",
        note: "Each agent supplies its own Pastebin Developer API Key. Nothing is baked into the Worker."
      },
      tools: [
        "create_paste",
        "get_paste",
        "list_pastes",
        "delete_paste",
        "login",
        "whoami"
      ]
    },
    200,
    corsHeaders(request)
  );
}
__name(handleRoot, "handleRoot");
function isOauthDiscoveryPath(pathname) {
  return pathname.startsWith("/.well-known/") || pathname === "/register" || pathname.includes("/.well-known/");
}
__name(isOauthDiscoveryPath, "isOauthDiscoveryPath");
var index_default = {
  async fetch(request, _env) {
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
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") return handleCorsPreflight(request);
      const auth = authenticate(request);
      if (auth instanceof Response) return auth;
      return handleMcp(request, auth);
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
