import { worker } from "./watchers.js";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try { await worker(undefined, controller.signal); }
catch { console.error("t3threads: watcher worker stopped. Run watch-run to restart; inspect watchers for per-watch errors."); process.exitCode = 1; }
