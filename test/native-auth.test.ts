import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { decryptSafeStorage, nativeRelayToken, nativeSignedIn } from "../src/native-auth.js";
import { fixture } from "./fixture.js";

test("Safe Storage adapter decodes the native macOS v10 envelope and rejects unknown formats", () => {
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync("password", "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32));
  const encoded = Buffer.concat([Buffer.from("v10"), cipher.update("native-client-token"), cipher.final()]).toString("base64");
  assert.equal(decryptSafeStorage(encoded, "password"), "native-client-token");
  assert.throws(() => decryptSafeStorage(Buffer.from("v99unrecognized").toString("base64"), "password"), { code: "NATIVE_AUTH_FORMAT" });
  assert.throws(() => decryptSafeStorage(encoded, "wrong"));
});

test("native auth reuses T3's active account without GUI, separate login, or cache mutation", async t => {
  const f = await fixture(t), path = f.dir + "/userdata/clerk-tokens.json";
  const original = JSON.stringify({ __clerk_client_jwt: "raw:native-client-token" });
  await writeFile(path, original);
  const fetch = globalThis.fetch, requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith(f.target.origin)) return fetch(url, init);
    requests.push(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer native-client-token"); assert.equal(init.redirect, "error");
    if (url.includes("/tokens/t3-relay")) return Response.json({ jwt: "native-relay-jwt" });
    return Response.json({ response: { last_active_session_id: "grace", sessions: [{ id: "ada", status: "active" }, { id: "grace", status: "active" }] } });
  });
  assert.equal(await nativeSignedIn({ home: f.dir }), true);
  assert.equal(await nativeRelayToken({ home: f.dir }), "native-relay-jwt");
  assert.ok(requests[1]!.includes("/sessions/grace/tokens/t3-relay"));
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, "{}");
  assert.equal(await nativeSignedIn({ home: f.dir }), false);
  await assert.rejects(nativeRelayToken({ home: f.dir }), { code: "T3_SIGN_IN_REQUIRED" });
});

test("native auth requires a running local T3 server even when saved credentials exist", async t => {
  const f = await fixture(t);
  await writeFile(f.dir + "/userdata/clerk-tokens.json", JSON.stringify({ __clerk_client_jwt: "raw:token" }));
  await writeFile(f.dir + "/userdata/server-runtime.json", JSON.stringify({ origin: "http://127.0.0.1:1" }));
  await assert.rejects(nativeRelayToken({ home: f.dir }), { code: "SERVER_UNREACHABLE" });
});
