import { worker } from "./watchers.js";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runtimeUpdateCheck } from "./runtime-update.js";
import { loadConfig, safeError } from "./environments.js";
import { nativeClientToken, nativeSignedIn } from "./native-auth.js";
import { State } from "./state.js";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const persistent = process.argv.includes("--persistent");
try {
  const checkUpdate = persistent ? await runtimeUpdateCheck(fileURLToPath(import.meta.url)) : undefined;
  let updated = false;
  let nextWarmup = 0;
  const state = new State();
  const maintenance = async () => {
    if (checkUpdate && (updated = await checkUpdate())) return true;
    if (persistent && Date.now() >= nextWarmup) {
      nextWarmup = Date.now() + 60_000;
      try {
        const c = await loadConfig({});
        const config = { ...c.connect, home: c.environments.local?.home ?? c.connect?.home };
        if (await nativeSignedIn(config)) await nativeClientToken(config, state);
        state.put("connection-health", "native", { checkedAt: new Date().toISOString(), error: null });
      } catch (error) {
        state.put("connection-health", "native", { checkedAt: new Date().toISOString(), error: safeError("connect", error) });
      }
    }
    return false;
  };
  do {
    await worker(state, controller.signal, undefined, persistent, maintenance);
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
