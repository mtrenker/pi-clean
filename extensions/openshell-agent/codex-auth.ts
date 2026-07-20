import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_AUTH_BYTES = 128 * 1024;
const MIN_VALIDITY_MS = 5 * 60 * 1000;
const TOKEN_KEYS = [
  "CODEX_AUTH_ACCESS_TOKEN",
  "CODEX_AUTH_REFRESH_TOKEN",
  "CODEX_AUTH_ACCOUNT_ID",
] as const;

export type CodexCredentials = Record<(typeof TOKEN_KEYS)[number], string>;

export async function readLocalCodexCredentials(path = join(homedir(), ".codex", "auth.json")): Promise<CodexCredentials> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_BYTES) throw new Error("unsafe_file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("wrong_owner");
    if ((stat.mode & 0o077) !== 0) throw new Error("unsafe_permissions");
    const parsed = JSON.parse(await handle.readFile("utf8")) as { tokens?: Record<string, unknown> };
    const tokens = parsed.tokens;
    const credentials = {
      CODEX_AUTH_ACCESS_TOKEN: token(tokens?.access_token, "access token"),
      CODEX_AUTH_REFRESH_TOKEN: token(tokens?.refresh_token, "refresh token"),
      CODEX_AUTH_ACCOUNT_ID: token(tokens?.account_id, "account id"),
    };
    const payload = jwtPayload(credentials.CODEX_AUTH_ACCESS_TOKEN);
    const expiry = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
    const account = (payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id;
    if (expiry < Date.now() + MIN_VALIDITY_MS) throw new Error("expired_access_token");
    if (account !== credentials.CODEX_AUTH_ACCOUNT_ID) throw new Error("account_mismatch");
    return credentials;
  } catch (error) {
    const code = error instanceof Error ? error.message : "unreadable";
    throw new Error(`Local Codex authentication is unavailable or unsafe (${safeCode(code)}). Refresh it with the official Codex CLI; no credential values were read into logs.`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function codexCredentialKeys(): readonly string[] {
  return TOKEN_KEYS;
}

function token(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 64 * 1024 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid_${name.replaceAll(" ", "_")}`);
  }
  return value;
}

function jwtPayload(value: string): Record<string, unknown> {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("invalid_access_token");
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("invalid_access_token");
  }
}

function safeCode(value: string): string {
  return /^[a-zA-Z0-9_ -]{1,80}$/.test(value) ? value.replaceAll(" ", "_") : "unreadable";
}
