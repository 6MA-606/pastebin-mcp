/** Minimal JSON-RPC / MCP Streamable HTTP helpers (stateless). */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

/** Versions this server can speak (newest first). */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
] as const;

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string") {
    if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      return requested;
    }
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

export function parseJsonRpcMessages(body: unknown): JsonRpcRequest[] {
  if (Array.isArray(body)) return body as JsonRpcRequest[];
  if (body && typeof body === "object") return [body as JsonRpcRequest];
  throw new Error("Invalid JSON-RPC body");
}

export function jsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export async function handleMcpRpc(
  message: JsonRpcRequest,
  tools: Record<string, { def: McpToolDef; handler: McpToolHandler }>,
  serverInfo: { name: string; version: string },
): Promise<JsonRpcResponse | null> {
  const { method, id } = message;
  const isNotification = id === undefined;

  if (
    method === "notifications/initialized" ||
    method.startsWith("notifications/")
  ) {
    return null;
  }

  if (isNotification) return null;

  const reqId = id ?? null;

  switch (method) {
    case "initialize": {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      return jsonRpcResult(reqId, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      });
    }

    case "ping":
      return jsonRpcResult(reqId, {});

    case "tools/list":
      return jsonRpcResult(reqId, {
        tools: Object.values(tools).map((t) => t.def),
      });

    case "tools/call": {
      const params = (message.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = params.name;
      if (!name || !tools[name]) {
        return jsonRpcError(
          reqId,
          -32601,
          `Unknown tool: ${name ?? "(missing)"}`,
        );
      }
      try {
        const result = await tools[name].handler(params.arguments ?? {});
        return jsonRpcResult(reqId, result);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(reqId, {
          content: [{ type: "text", text }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(reqId, -32601, `Method not found: ${method}`);
  }
}

/** Prefer SSE when the client Accept does not include application/json. */
export function wantsSseResponse(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (!accept) return false;
  const wantsJson = accept.includes("application/json");
  const wantsSse = accept.includes("text/event-stream");
  return wantsSse && !wantsJson;
}

export function mcpJsonResponse(
  payload: unknown,
  request: Request,
  status = 200,
): Response {
  const cors = corsHeaders(request);
  if (wantsSseResponse(request)) {
    const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(data, {
      status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...cors,
      },
    });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...cors,
    },
  });
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  return {
    // Echo concrete Origin when present (credentials-friendly); else *
    "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, X-API-Key, X-Pastebin-User-Key, X-API-User-Key, Mcp-Protocol-Version, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
