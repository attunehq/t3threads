import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { discover, exists, expand, fail, object, type ConnectConfig } from "./client.js";

const exec = promisify(execFile);
export const nativeHome = (config: ConnectConfig = {}) => expand(config.home ?? process.env.T3CODE_HOME ?? "~/.t3");
export async function nativeSignedIn(config: ConnectConfig = {}) {
  const path = join(nativeHome(config), "userdata/clerk-tokens.json");
  if (!await exists(path)) return false;
  try { return Boolean(object(JSON.parse(await readFile(path, "utf8"))).__clerk_client_jwt); }
  catch { return false; }
}

/** Electron's macOS Safe Storage v10 format. Read-only: T3 owns the cache and Keychain item. */
export function decryptSafeStorage(encoded: string, password: string) {
  const encrypted = Buffer.from(encoded, "base64");
  if (encrypted.subarray(0, 3).toString() !== "v10") fail("NATIVE_AUTH_FORMAT", "T3's Safe Storage format is not supported by this adapter.");
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString("utf8");
  } finally { key.fill(0); }
}
async function clientToken(config: ConnectConfig) {
  const home = nativeHome(config);
  await discover("local", { home });
  let stored: unknown;
  try { stored = object(JSON.parse(await readFile(join(home, "userdata/clerk-tokens.json"), "utf8"))).__clerk_client_jwt; }
  catch { return fail("T3_SIGN_IN_REQUIRED", "Sign in to T3 Connect in the running T3 desktop app."); }
  if (typeof stored !== "string" || !stored) fail("T3_SIGN_IN_REQUIRED", "Sign in to T3 Connect in the running T3 desktop app.");
  if (stored.startsWith("raw:")) return stored.slice(4);
  if (!stored.startsWith("enc:")) fail("NATIVE_AUTH_FORMAT", "T3's Clerk storage format is not supported.");
  if (process.platform !== "darwin") fail("NATIVE_AUTH_UNSUPPORTED", "This build can read the T3 desktop Safe Storage cache on macOS. Windows/Linux native keyring adapters are not implemented.");
  // Names follow Electron's app identity; t3code is the legacy identity retained by existing installs.
  for (const service of ["t3code Safe Storage", "T3 Code (Nightly) Safe Storage", "T3 Code Safe Storage"]) {
    try {
      const { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", timeout: 30_000 });
      const value = decryptSafeStorage(stored.slice(4), stdout.trimEnd());
      if (value) return value;
    } catch { /* Try only known T3 app identities; never return credential-bearing command errors. */ }
  }
  return fail("NATIVE_AUTH_LOCKED", "Cannot unlock T3's Safe Storage cache. Unlock the login Keychain and allow access to T3's Safe Storage item.");
}
export async function nativeRelayToken(config: ConnectConfig = {}, signal?: AbortSignal): Promise<string> {
  const token = await clientToken(config);
  const issuer = config.issuerUrl ?? "https://clerk.t3.codes";
  if (new URL(issuer).protocol !== "https:") fail("INVALID_CONFIG", "Clerk native authentication requires HTTPS.");
  const headers = { authorization: `Bearer ${token}` };
  const request = async (path: string, method = "GET") => {
    let response: Response;
    try { response = await fetch(`${issuer}${path}?_is_native=true`, { method, headers, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) }); }
    catch { return fail("NATIVE_AUTH_FAILED", "Could not reach T3's sign-in provider."); }
    if (!response.ok) fail("T3_SIGN_IN_REQUIRED", `T3's sign-in provider returned HTTP ${response.status}. Refresh sign-in in T3 Code.`);
    return object(await response.json());
  };
  const client = object((await request("/v1/client")).response);
  const sessions = client.sessions;
  if (!Array.isArray(sessions)) fail("NATIVE_AUTH_FORMAT", "Clerk returned an incompatible client.");
  const active = sessions.map(object).filter(s => s.status === "active");
  const selected = active.find(s => s.id === client.last_active_session_id) ?? (active.length === 1 ? active[0] : undefined);
  if (!selected || typeof selected.id !== "string") fail("T3_SIGN_IN_REQUIRED", "Choose an active T3 Connect account in T3 Code first.");
  const result = await request(`/v1/client/sessions/${encodeURIComponent(selected.id)}/tokens/${encodeURIComponent(config.jwtTemplate ?? "t3-relay")}`, "POST");
  if (typeof result.jwt !== "string" || !result.jwt) fail("NATIVE_AUTH_FORMAT", "Clerk returned an invalid relay session token.");
  return result.jwt;
}
