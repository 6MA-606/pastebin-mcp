/** Pastebin.com Developers API client (https://pastebin.com/doc_api). */

const API_POST = "https://pastebin.com/api/api_post.php";
const API_RAW = "https://pastebin.com/api/api_raw.php";
const RAW_PUBLIC = "https://pastebin.com/raw/";

export type PastebinCreds = {
  /** Pastebin Developer API Key (api_dev_key) */
  devKey: string;
  /** Optional member session key (api_user_key) for private pastes / list / delete */
  userKey?: string;
};

export type CreatePasteInput = {
  content: string;
  title?: string;
  language?: string;
  /** 0=public, 1=unlisted (default), 2=private (needs userKey) */
  visibility?: 0 | 1 | 2;
  /** e.g. N, 10M, 1H, 1D, 1W, 2W, 1M, 6M, 1Y */
  expire?: string;
};

function formBody(fields: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== "") p.set(k, v);
  }
  return p.toString();
}

async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields),
  });
  const text = await res.text();
  return text.trim();
}

function isPastebinError(text: string): boolean {
  return text.toLowerCase().startsWith("bad api request");
}

export function pasteKeyFromUrlOrId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const m = /pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)/i.exec(trimmed);
  if (m) return m[1];
  return trimmed.replace(/^\/+/, "");
}

export async function createPaste(
  creds: PastebinCreds,
  input: CreatePasteInput,
): Promise<{ url: string; id: string }> {
  const visibility = input.visibility ?? 1;
  if (visibility === 2 && !creds.userKey) {
    throw new Error(
      "Private pastes require X-Pastebin-User-Key (api_user_key from Pastebin login API)",
    );
  }

  const fields: Record<string, string> = {
    api_dev_key: creds.devKey,
    api_option: "paste",
    api_paste_code: input.content,
    api_paste_private: String(visibility),
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

export async function getPaste(
  creds: PastebinCreds,
  idOrUrl: string,
): Promise<{ id: string; url: string; content: string; source: string }> {
  const id = pasteKeyFromUrlOrId(idOrUrl);

  // Prefer authenticated raw for private pastes when user key is present
  if (creds.userKey) {
    const text = await postForm(API_RAW, {
      api_dev_key: creds.devKey,
      api_user_key: creds.userKey,
      api_paste_key: id,
      api_option: "show_paste",
    });
    if (!isPastebinError(text)) {
      return {
        id,
        url: `https://pastebin.com/${id}`,
        content: text,
        source: "api_raw",
      };
    }
  }

  const res = await fetch(`${RAW_PUBLIC}${id}`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch paste ${id}: HTTP ${res.status}${
        creds.userKey ? "" : " (private pastes need X-Pastebin-User-Key)"
      }`,
    );
  }
  const content = await res.text();
  return {
    id,
    url: `https://pastebin.com/${id}`,
    content,
    source: "raw",
  };
}

export type PasteListItem = {
  paste_key: string;
  paste_title: string;
  paste_date: string;
  paste_size: string;
  paste_private: string;
  paste_format_short: string;
  paste_url: string;
  paste_hits?: string;
};

export async function listPastes(
  creds: PastebinCreds,
  limit = 50,
): Promise<PasteListItem[]> {
  if (!creds.userKey) {
    throw new Error(
      "list_pastes requires X-Pastebin-User-Key (api_user_key). Guest keys cannot list pastes.",
    );
  }
  const text = await postForm(API_POST, {
    api_dev_key: creds.devKey,
    api_user_key: creds.userKey,
    api_option: "list",
    api_results_limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (isPastebinError(text)) throw new Error(text);
  if (!text || text === "No pastes found.") return [];

  // Response is XML list of <paste>…</paste>
  const items: PasteListItem[] = [];
  const blocks = text.match(/<paste>[\s\S]*?<\/paste>/g) ?? [];
  for (const block of blocks) {
    const get = (tag: string) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return m ? m[1].trim() : "";
    };
    items.push({
      paste_key: get("paste_key"),
      paste_title: get("paste_title"),
      paste_date: get("paste_date"),
      paste_size: get("paste_size"),
      paste_private: get("paste_private"),
      paste_format_short: get("paste_format_short"),
      paste_url: get("paste_url"),
      paste_hits: get("paste_hits") || undefined,
    });
  }
  return items;
}

export async function deletePaste(
  creds: PastebinCreds,
  idOrUrl: string,
): Promise<{ ok: true; id: string }> {
  if (!creds.userKey) {
    throw new Error(
      "delete_paste requires X-Pastebin-User-Key (api_user_key).",
    );
  }
  const id = pasteKeyFromUrlOrId(idOrUrl);
  const text = await postForm(API_POST, {
    api_dev_key: creds.devKey,
    api_user_key: creds.userKey,
    api_paste_key: id,
    api_option: "delete",
  });
  if (isPastebinError(text) && !/deleted/i.test(text)) {
    throw new Error(text);
  }
  // Success is typically "Paste Removed"
  return { ok: true, id };
}

export async function loginUser(
  devKey: string,
  username: string,
  password: string,
): Promise<string> {
  const text = await postForm("https://pastebin.com/api/api_login.php", {
    api_dev_key: devKey,
    api_user_name: username,
    api_user_password: password,
  });
  if (isPastebinError(text) || text.length < 8) {
    throw new Error(text || "Pastebin login failed");
  }
  return text;
}
