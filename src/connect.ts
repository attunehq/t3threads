import { generateKeyPairSync, createHash, sign, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Api, fail, object, originOnly, type ConnectConfig, type Environment, type Target } from "./client.js";
import { digest, State } from "./state.js";
import { nativeRelayToken, nativeSignedIn } from "./native-auth.js";

const settings = (config: ConnectConfig = {}) => ({ relayUrl: "https://relay.t3.codes", ...config });
const authKey = (config: ConnectConfig) => digest(config);
type OAuth = { accessToken: string; expiresAt: number };
export type LinkedEnvironment = { environmentId: string; label: string; endpoint: { httpBaseUrl: string; wsBaseUrl: string } };
export const isConnected = nativeSignedIn;

async function request(url: string, init: RequestInit = {}, signal?: AbortSignal) {
  originOnly(new URL(url).origin);
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) }); }
  catch { return fail("CONNECT_UNREACHABLE", "T3 Connect request failed or was cancelled."); }
  let data: Record<string, unknown>;
  try { data = object(await response.json()); } catch { return fail("CONNECT_RESPONSE", "T3 Connect returned an invalid response."); }
  return { response, data };
}
function token(data: Record<string, unknown>): OAuth {
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number" || data.expires_in <= 0) fail("CONNECT_RESPONSE", "T3 Connect returned an invalid access token.");
  return { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}
const form = (values: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });

export async function linkedEnvironments(config: ConnectConfig = {}, _state = new State(), signal?: AbortSignal, getToken = nativeRelayToken) {
  const { response, data } = await request(`${originOnly(settings(config).relayUrl)}/v1/environments`, { headers: { authorization: `Bearer ${await getToken(config, signal)}` } }, signal);
  if (!response.ok) fail("CONNECT_DISCOVERY_FAILED", `T3 Connect environment discovery returned HTTP ${response.status}.`);
  if (!Array.isArray(data.environments)) fail("CONNECT_RESPONSE", "T3 Connect returned no environment list.");
  return data.environments.map(raw => {
    const e = object(raw), endpoint = object(e.endpoint);
    if (typeof e.environmentId !== "string" || !/^[\w-]+$/.test(e.environmentId) || typeof e.label !== "string" || typeof endpoint.httpBaseUrl !== "string") fail("CONNECT_RESPONSE", "T3 Connect returned an invalid environment.");
    originOnly(endpoint.httpBaseUrl);
    return e as LinkedEnvironment;
  });
}
export function linkedConfig(e: LinkedEnvironment, connect: ConnectConfig): Environment {
  return { url: e.endpoint.httpBaseUrl, connectId: e.environmentId, label: e.label, connect };
}

export class ProofKey {
  private privateKey: KeyObject;
  readonly jwk;
  readonly thumbprint: string;
  constructor(pem?: string) {
    this.privateKey = pem ? createPrivateKey(pem) : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    this.jwk = createPublicKey(this.privateKey).export({ format: "jwk" });
    this.thumbprint = createHash("sha256").update(JSON.stringify({ crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x, y: this.jwk.y })).digest("base64url");
  }
  export() { return String(this.privateKey.export({ type: "pkcs8", format: "pem" })); }
  proof(method: string, rawUrl: string, access?: string) {
    const url = new URL(rawUrl); url.search = ""; url.hash = "";
    const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const input = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk: this.jwk })}.${encode({ jti: crypto.randomUUID(), htm: method, htu: url.href, iat: Math.floor(Date.now() / 1000), ...(access ? { ath: createHash("sha256").update(access).digest("base64url") } : {}) })}`;
    return `${input}.${sign("sha256", Buffer.from(input), { key: this.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  }
}
export async function connectApi(target: Target, signal?: AbortSignal, state = new State(), getToken = nativeRelayToken) {
  const config = target.config.connect ?? {}, relay = originOnly(settings(config).relayUrl);
  let nativeToken = await getToken(config, signal);
  const claims = object(JSON.parse(Buffer.from(nativeToken.split(".")[1]!, "base64url").toString()));
  const accountFingerprint = digest([claims.iss, claims.sub]);
  const sessionKey = `${authKey(config)}:${digest([target.descriptor.environmentId, target.origin, accountFingerprint])}`;
  const pem = state.update<string>("proof-key", sessionKey, previous => previous ?? new ProofKey().export());
  const key = new ProofKey(pem);
  let session: OAuth | undefined;
  async function renew() {
    nativeToken = await getToken(config, signal);
    const url = `${relay}/v1/client/dpop-token`;
    const init = form({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: nativeToken, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", resource: relay, scope: "environment:connect", client_id: "t3-web" });
    const exchanged = await request(url, { ...init, headers: { ...init.headers, dpop: key.proof("POST", url) } }, signal);
    if (!exchanged.response.ok || exchanged.data.token_type !== "DPoP" || exchanged.data.scope !== "environment:connect") fail("CONNECT_AUTH_FAILED", `T3 Connect token exchange failed (HTTP ${exchanged.response.status}). Refresh the T3 Connect sign-in in the running T3 app.`);
    const relayToken = token(exchanged.data).accessToken;
    const connectUrl = `${relay}/v1/environments/${encodeURIComponent(target.config.connectId!)}/connect`;
    const connected = await request(connectUrl, { method: "POST", headers: { authorization: `DPoP ${relayToken}`, dpop: key.proof("POST", connectUrl, relayToken), "content-type": "application/json" }, body: JSON.stringify({ clientProofKeyThumbprint: key.thumbprint }) }, signal);
    if (!connected.response.ok) fail("CONNECT_OFFLINE", `Could not connect to ${target.name} (HTTP ${connected.response.status}).`);
    const endpoint = object(connected.data.endpoint);
    if (connected.data.environmentId !== target.descriptor.environmentId || typeof endpoint.httpBaseUrl !== "string" || originOnly(endpoint.httpBaseUrl) !== target.origin || typeof connected.data.credential !== "string") fail("CONNECT_IDENTITY_MISMATCH", "Connect returned a different environment or endpoint.");
    const tokenUrl = `${target.origin}/oauth/token`;
    const exchange = form({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: connected.data.credential, subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", scope: "orchestration:read orchestration:operate", client_label: "t3threads", client_device_type: "bot" });
    const granted = await request(tokenUrl, { ...exchange, headers: { ...exchange.headers, dpop: key.proof("POST", tokenUrl) } }, signal);
    if (!granted.response.ok || granted.data.token_type !== "DPoP") fail("CONNECT_AUTH_FAILED", "The environment could not establish a DPoP session.");
    session = token(granted.data);
    state.put("connect-session", sessionKey, session);
  }
  const ensureSession = () => state.lock(`session-${sessionKey}`, async () => {
    session = state.get<OAuth>("connect-session", sessionKey);
    if (!session || session.expiresAt < Date.now() + 30_000) await renew();
  }, signal);
  await ensureSession();
  return new Api(target, "", signal, async (method, url) => {
    if (!session || session.expiresAt < Date.now() + 30_000) await ensureSession();
    return { authorization: `DPoP ${session!.accessToken}`, dpop: key.proof(method, url, session!.accessToken) };
  });
}
