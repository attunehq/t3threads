#!/usr/bin/env node
import { createCli } from "./cli.js";

const controller = new AbortController();
const stop = () => {
  controller.abort();
  process.stdin.destroy();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await createCli({ signal: controller.signal }).serve();
