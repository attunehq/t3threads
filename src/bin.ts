#!/usr/bin/env node
import { createCli } from "./cli.js";
import { ensureWorker } from "./watchers.js";

const controller = new AbortController();
const stop = () => {
  controller.abort();
  process.stdin.destroy();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (!process.argv.includes("watch-run") && !process.argv.includes("service")) ensureWorker();
await createCli({ signal: controller.signal }).serve();
