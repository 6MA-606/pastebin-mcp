export type Paste = {
  id: string;
  content: string;
  title?: string;
  language?: string;
  createdAt: string;
  updatedAt: string;
  /** Owner key hash — never returned to other tenants */
  ownerHash: string;
};

const PASTE_ID_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function generatePasteId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const b of bytes) {
    id += PASTE_ID_ALPHABET[b % PASTE_ID_ALPHABET.length];
  }
  return id;
}

function pasteKey(ownerHash: string, pasteId: string): string {
  return `paste:${ownerHash}:${pasteId}`;
}

function indexKey(ownerHash: string): string {
  return `index:${ownerHash}`;
}

export async function createPaste(
  kv: KVNamespace,
  ownerHash: string,
  input: { content: string; title?: string; language?: string },
): Promise<Paste> {
  const now = new Date().toISOString();
  const id = generatePasteId();
  const paste: Paste = {
    id,
    content: input.content,
    title: input.title,
    language: input.language,
    createdAt: now,
    updatedAt: now,
    ownerHash,
  };

  await kv.put(pasteKey(ownerHash, id), JSON.stringify(paste));

  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  index.unshift(id);
  // Cap index size to keep list responses bounded
  const trimmed = index.slice(0, 500);
  await kv.put(indexKey(ownerHash), JSON.stringify(trimmed));

  return paste;
}

export async function getPaste(
  kv: KVNamespace,
  ownerHash: string,
  pasteId: string,
): Promise<Paste | null> {
  const raw = await kv.get(pasteKey(ownerHash, pasteId), "json");
  if (!raw || typeof raw !== "object") return null;
  const paste = raw as Paste;
  if (paste.ownerHash !== ownerHash) return null;
  return paste;
}

export type PasteSummary = {
  id: string;
  title?: string;
  language?: string;
  createdAt: string;
  updatedAt: string;
  size: number;
};

export async function listPastes(
  kv: KVNamespace,
  ownerHash: string,
  limit = 50,
): Promise<PasteSummary[]> {
  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  const ids = index.slice(0, Math.min(Math.max(limit, 1), 100));

  const summaries: PasteSummary[] = [];
  for (const id of ids) {
    const paste = await getPaste(kv, ownerHash, id);
    if (!paste) continue;
    summaries.push({
      id: paste.id,
      title: paste.title,
      language: paste.language,
      createdAt: paste.createdAt,
      updatedAt: paste.updatedAt,
      size: paste.content.length,
    });
  }
  return summaries;
}

export async function deletePaste(
  kv: KVNamespace,
  ownerHash: string,
  pasteId: string,
): Promise<boolean> {
  const existing = await getPaste(kv, ownerHash, pasteId);
  if (!existing) return false;

  await kv.delete(pasteKey(ownerHash, pasteId));

  const indexRaw = await kv.get(indexKey(ownerHash), "json");
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  const next = index.filter((id) => id !== pasteId);
  await kv.put(indexKey(ownerHash), JSON.stringify(next));
  return true;
}

export function publicPaste(paste: Paste) {
  return {
    id: paste.id,
    content: paste.content,
    title: paste.title ?? null,
    language: paste.language ?? null,
    createdAt: paste.createdAt,
    updatedAt: paste.updatedAt,
  };
}
