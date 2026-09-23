import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify, createHash } from "node:crypto";
import { connectApi, ProofKey, linkedEnvironments } from "../src/connect.js";
import { State } from "../src/state.js";
import { fixture } from "./fixture.js";
const cloudToken = "header." + Buffer.from(JSON.stringify({iss:"issuer",sub:"user"})).toString("base64url") + ".signature";

test("DPoP proofs bind method, origin/path, token hash and unique jti with a valid ES256 signature", () => {
  const signer = new ProofKey();
  const jwt = signer.proof("POST", "https://server.test/api/auth/websocket-ticket?x=1", "token");
  const [header, claims, signature] = jwt.split(".");
  const h = JSON.parse(Buffer.from(header!, "base64url").toString());
  const c = JSON.parse(Buffer.from(claims!, "base64url").toString());
  assert.equal(h.alg, "ES256"); assert.equal(h.typ, "dpop+jwt");
  assert.equal(c.htu, "https://server.test/api/auth/websocket-ticket"); assert.equal(c.htm, "POST");
  assert.equal(c.ath, createHash("sha256").update("token").digest("base64url"));
  assert.equal(verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: h.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url")), true);
  assert.notEqual(jwt, signer.proof("POST", "https://server.test/api/auth/websocket-ticket?x=1", "token"));
  assert.equal(new ProofKey(signer.export()).thumbprint, signer.thumbprint);
});

test("Connect exchanges proofs, validates environment identity, and reuses stored sessions across instances", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const config = { relayUrl: "https://relay.test" };
  process.env.T3THREADS_TEST_CONNECT = "cloud-secret";
  t.after(() => { delete process.env.T3THREADS_TEST_CONNECT; });
  const target = { ...f.target, home: undefined, origin: "https://environment.test", config: { connectId: f.target.descriptor.environmentId, connect: config } };
  let grants = 0, proofKey: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    const proof = headers.get("dpop");
    if (proof) { const jwk = JSON.parse(Buffer.from(proof.split(".")[0]!, "base64url").toString()).jwk; proofKey ??= JSON.stringify(jwk); assert.equal(JSON.stringify(jwk), proofKey); }
    if (url.endsWith("/dpop-token")) {
      assert.equal(new URLSearchParams(String(init.body)).get("subject_token"), cloudToken);
      return Response.json({ access_token: "relay-secret", expires_in: 300, token_type: "DPoP", scope: "environment:connect" });
    }
    if (url.endsWith("/connect")) return Response.json({ environmentId: target.descriptor.environmentId, endpoint: { httpBaseUrl: target.origin + "/" }, credential: "bootstrap" });
    if (url.endsWith("/oauth/token")) { grants++; assert.equal(new URLSearchParams(String(init.body)).get("subject_token"), "bootstrap"); return Response.json({ access_token: "environment-secret", expires_in: 3600, token_type: "DPoP" }); }
    assert.equal(headers.get("authorization"), "DPoP environment-secret");
    assert.ok(proof); return Response.json({ ok: true });
  });
  assert.deepEqual(await (await connectApi(target, undefined, state, async () => cloudToken)).request("/api/read"), { ok: true });
  assert.deepEqual(await (await connectApi(target, undefined, new State(state.directory), async () => cloudToken)).request("/api/read"), { ok: true });
  assert.equal(grants, 1);
});

test("Connect cannot substitute another host during credential exchange", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  process.env.T3THREADS_TEST_CONNECT = "cloud-secret"; t.after(() => { delete process.env.T3THREADS_TEST_CONNECT; });
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("dpop-token") ? Response.json({ access_token: "relay", expires_in: 300, token_type: "DPoP", scope: "environment:connect" }) : Response.json({ environmentId: "wrong", endpoint: { httpBaseUrl: "https://evil.test" }, credential: "secret" }));
  await assert.rejects(connectApi({ ...f.target, origin: "https://environment.test", config: { connectId: "test-env", connect: { relayUrl: "https://relay.test" } } }, undefined, state, async () => cloudToken), { code: "CONNECT_IDENTITY_MISMATCH" });
});

