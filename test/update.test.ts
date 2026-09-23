import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCli } from "../src/cli.js";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "t3threads-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "npm-args.json");
  const script = join(directory, "npm.cjs");
  await writeFile(script, `#!${process.execPath}
require("node:fs").writeFileSync(process.env.UPDATE_TEST_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.UPDATE_TEST_FAIL) {
  console.error("npm error EACCES: global prefix is not writable");
  process.exit(17);
}
console.log("changed 1 package");
`);
  if (process.platform === "win32") {
    await writeFile(join(directory, "npm.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    await writeFile(join(directory, "npm"), await readFile(script), { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, T3THREADS_STATE_DIR: join(directory, "state"), UPDATE_TEST_LOG: log };
  return {
    log,
    run: (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => exec(process.execPath, ["--import", "tsx", resolve("src/bin.ts"), ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000 }),
  };
}

test("update installs the latest npm release globally and returns clean JSON", async t => {
  const f = await fixture(t);
  const result = await f.run(["update", "--json"]);
  assert.deepEqual(JSON.parse(result.stdout), { status: "updated", package: "t3threads@latest" });
  assert.deepEqual(JSON.parse(await readFile(f.log, "utf8")), ["install", "--global", "t3threads@latest"]);
});

test("update reports npm failures and exits nonzero", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(["update", "--json"], { UPDATE_TEST_FAIL: "1" }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /UPDATE_FAILED/);
    assert.match(error.stdout, /EACCES: global prefix is not writable/);
    return true;
  });
});

test("update reports when npm is unavailable", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(["update", "--json"], { PATH: "" }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /UPDATE_FAILED/);
    assert.match(error.stdout, /npm/);
    return true;
  });
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
});

test("update help and invalid flags do not run npm", async t => {
  const f = await fixture(t);
  assert.match((await f.run(["update", "--help"])).stdout, /latest t3threads release from npm/);
  await assert.rejects(f.run(["update", "--unexpected", "--json"]));
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
});

test("update rejects HTTP GET before installing", async () => {
  const response = await createCli().fetch(new Request("http://cli/update"));
  assert.match(await response.text(), /METHOD_NOT_ALLOWED/);
});
