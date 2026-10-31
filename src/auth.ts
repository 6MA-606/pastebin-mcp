export type AgentIdentity = {
  /** SHA-256 hex of the raw API key — used as the paste tenant id */
  keyHash: string;
  /** Short fingerprint for logs / tool responses (not secret) */
  fingerprint: string;
};

const MIN_KEY_LENGTH = 24;

export function extractApiKey(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }

  const apiKey = request.headers.get("X-API-Key")?.trim();
  return apiKey || null;
}

export function isValidKeyFormat(key: string): boolean {
  return key.length >= MIN_KEY_LENGTH && /^[\x21-\x7E]+$/.test(key);
}

export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function identityFromKey(key: string): Promise<AgentIdentity> {
  const keyHash = await hashApiKey(key);
  return {
    keyHash,
    fingerprint: keyHash.slice(0, 12),
  };
}

/** Generate a random pastebin API key for an agent. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // base64url without padding
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type KeyRecord = {
  createdAt: string;
  label?: string;
  fingerprint: string;
};

export async function ensureKeyRegistered(
  kv: KVNamespace,
  identity: AgentIdentity,
  label?: string,
): Promise<KeyRecord> {
  const keyPath = `key:${identity.keyHash}`;
  const existing = await kv.get(keyPath, "json");
  if (existing && typeof existing === "object") {
    return existing as KeyRecord;
  }

  const record: KeyRecord = {
    createdAt: new Date().toISOString(),
    fingerprint: identity.fingerprint,
    ...(label ? { label } : {}),
  };
  await kv.put(keyPath, JSON.stringify(record));
  return record;
}
