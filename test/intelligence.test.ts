import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/state.js";
import { card, summarize, semanticSearch, judge, jev, questionsSchema, type Generator, type Card } from "../src/intelligence.js";
import { fixture, thread, message } from "./fixture.js";

test("cards bound history, invalidate changed content, and summaries avoid repeated model calls", async t => {
  const f = await fixture(t), state = new State(f.dir + "/cache");
  f.stored.get("t1")!.messages = [message("1", "a".repeat(20_000))];
  const first = await card(f.api, thread, 8, state);
  assert.equal(first.coverage.truncated, true);
  assert.ok(first.text.length < 13_000);
  let calls = 0;
  const model: Generator = { identity: "saved-model", async generate() { calls++; return { value: { summary: "Working on parser", work: ["parser"], files: [], pullRequests: [], blockers: [] } }; } };
  assert.equal((await summarize(first, model, state)).cached, false);
  assert.equal((await summarize(first, model, state)).cached, true);
  assert.equal(calls, 1);
  f.stored.get("t1")!.messages = [message("2", "new task")];
  const changed = await card(f.api, { ...thread, updatedAt: "tomorrow" }, 8, state);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  await summarize(changed, model, state);
  assert.equal(calls, 2);
});

test("semantic relevance batches threads, validates result membership, and caches by query and model", async t => {
  const f = await fixture(t), state = new State(f.dir + "/cache"), base = await card(f.api, thread, 8, state);
  const cards = [base, { ...base, ref: "remote:t2", fingerprint: "second" }];
  let calls = 0;
  const model: Generator = { identity: "model1", async generate() { calls++; return { value: { results: cards.map((c, i) => ({ ref: c.ref, relevant: i === 0, reason: "same parser" })) } }; } };
  assert.deepEqual((await semanticSearch(cards, "parser overlap", model, state)).matches, [{ ref: base.ref, reason: "same parser" }]);
  assert.equal((await semanticSearch(cards, "parser overlap", model, state)).modelCalls, 0);
  assert.equal(calls, 1);
  await assert.rejects(semanticSearch(cards, "different", { identity: "model1", async generate() { return { value: { results: [{ ref: "invented", relevant: true, reason: "bad" }] } }; } }, state), { code: "MODEL_RESPONSE" });
});

test("Jev validates typed answers, records actual model and usage, and reuses unchanged judgments", async t => {
  const f = await fixture(t), state = new State(f.dir + "/cache");
  const previous = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = "test-key";
  t.after(() => { if (previous) process.env.TYPESAFE_API_KEY = previous; else delete process.env.TYPESAFE_API_KEY; });
  let calls = 0, invalid = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, "error");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "jev-1.13.0");
    return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: invalid ? 2 : 0.98 }])), usage: { input_tokens: 40, output_tokens: 2 } });
  });
  const qs = questionsSchema.parse({ overlap: { type: "noul", instructions: "Does this overlap with the parser?" } });
  const result = await jev({ work: "parser" }, qs, state);
  assert.equal(result.cached, false); assert.equal(result.model, "jev-1.13.0");
  assert.equal((await jev({ work: "parser" }, qs, state)).cached, true); assert.equal(calls, 1);
  const decision = await judge([] as Card[], "finished", "jev", undefined, state);
  assert.equal(decision.matches, true); assert.equal(decision.probability, 0.98);
  invalid = true;
  await assert.rejects(jev("new", qs, state), { code: "JEV_RESPONSE" });
});
