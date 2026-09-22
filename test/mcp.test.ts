import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fixture } from "./fixture.js";
import { createCli } from "../src/cli.js";

test("stdio MCP advertises schemas and runs the same read and write commands", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: any) => void>();
  let nextID = 1, stderr = "";
  child.stderr.on("data", data => { stderr += String(data); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  t.after(async () => {
    lines.close();
    const ended = once(child, "exit");
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 3000);
    child.kill("SIGTERM");
    await ended;
    clearTimeout(timer);
    assert.equal(forced, false, "MCP server should exit on SIGTERM");
  });
  const call = (method: string, params: object = {}) => {
    const id = nextID++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`MCP timeout: ${method}; ${stderr}`)), 8000);
      pending.set(id, result => { clearTimeout(timer); resolve(result); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t3threads-test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "t3threads");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await call("tools/list");
  const tools = listed.result.tools as { name: string; annotations: { readOnlyHint: boolean; idempotentHint: boolean }; inputSchema: { properties: Record<string, unknown> } }[];
  assert.deepEqual(tools.map(t => t.name).sort(), ["doctor", "environments", "list", "projects", "read", "search", "send", "start"]);
  assert.equal(tools.find(t => t.name === "read")?.annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === "start")?.annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === "start")?.annotations.idempotentHint, false);
  assert.ok(tools.find(t => t.name === "read")?.inputSchema.properties.env);
  const doctor = await call("tools/call", { name: "doctor", arguments: { config: f.configPath } });
  assert.ok(!doctor.result.isError, JSON.stringify(doctor));
  const start = await call("tools/call", { name: "start", arguments: { config: f.configPath, project: "p1", checkout: "worktree", branch: "main", prompt: "Review this task" } });
  assert.ok(!start.result.isError, JSON.stringify(start));
  assert.equal(f.commands.length, 1);
  const read = await call("tools/call", { name: "read", arguments: { config: f.configPath, thread: f.commands[0]!.threadId } });
  assert.ok(!read.result.isError, JSON.stringify(read));
  assert.ok(JSON.stringify(read.result).includes("Review this task"));
  const invalid = await call("tools/call", { name: "read", arguments: { config: f.configPath, thread: "t1", turns: 0 } });
  assert.equal(invalid.result.isError, true);
  assert.ok(!stderr.includes("test-secret"));
});

test("Fetch surface includes OpenAPI and HTTP MCP discovery", async () => {
  const cli = createCli();
  const schema = await (await cli.fetch(new Request("http://cli/openapi.json"))).json() as { paths: Record<string, unknown> };
  assert.ok(Object.keys(schema.paths).some(p => p.includes("start")));
  const response = await cli.fetch(new Request("http://cli/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) }));
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("t3threads"));
});
