import { worker } from "./watchers.js";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runtimeUpdateCheck } from "./runtime-update.js";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const persistent = process.argv.includes("--persistent");
try {
  const checkUpdate = persistent ? await runtimeUpdateCheck(fileURLToPath(import.meta.url)) : undefined;
  let updated = false;
  do {
    await worker(undefined, controller.signal, undefined, persistent, checkUpdate ? async () => updated = await checkUpdate() : undefined);
    if (updated) {
      console.error("t3threads: installed package changed; restarting the service with the updated code.");
      break;
    }
    // A detached worker may still own the lease when the service starts.
    if (persistent && !controller.signal.aborted) await delay(1000, undefined, { signal: controller.signal });
  } while (persistent && !controller.signal.aborted);
} catch {
  if (!controller.signal.aborted) {
    console.error("t3threads: delivery worker stopped. Inspect watchers and queued for errors; an installed service will restart automatically.");
    process.exitCode = 1;
  }
}
