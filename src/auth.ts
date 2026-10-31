export type PastebinCreds = {
  /** Pastebin Developer API Key — supplied by the calling agent */
  devKey: string;
  /** Optional Pastebin member session key */
  userKey?: string;
};

const MIN_DEV_KEY_LENGTH = 8;

export function extractDevKey(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = request.headers.get("X-API-Key")?.trim();
  return apiKey || null;
}

export function extractUserKey(request: Request): string | undefined {
  const h =
    request.headers.get("X-Pastebin-User-Key")?.trim() ||
    request.headers.get("X-API-User-Key")?.trim();
  return h || undefined;
}

export function isValidDevKeyFormat(key: string): boolean {
  // Pastebin api_dev_key is typically 32 hex chars; accept a wider printable range
  return key.length >= MIN_DEV_KEY_LENGTH && /^[\x21-\x7E]+$/.test(key);
}

export function credsFromRequest(request: Request): PastebinCreds | null {
  const devKey = extractDevKey(request);
  if (!devKey || !isValidDevKeyFormat(devKey)) return null;
  return {
    devKey,
    userKey: extractUserKey(request),
  };
}
