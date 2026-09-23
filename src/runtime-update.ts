import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

async function revision(script: string) {
  const directory = dirname(script);
  const names = (await readdir(directory)).filter(name => name.endsWith(extname(script))).sort();
  if (!names.includes(basename(script))) throw Error("Runtime replacement is incomplete.");
  const hash = createHash("sha256");
  hash.update(await readFile(join(directory, "..", "package.json")));
  for (const name of names) hash.update(name).update(await readFile(join(directory, name)));
  return hash.digest("hex");
}

/** Notice package replacement even when npm lifecycle scripts are disabled. */
export async function runtimeUpdateCheck(script: string) {
  const initial = await revision(script);
  let nextCheck = 0, candidate: string | undefined;
  return async (now = Date.now()) => {
    if (now < nextCheck) return false;
    nextCheck = now + 5000;
    try {
      const current = await revision(script);
      // Package managers replace several files. Require two matching observations
      // before leaving the loaded runtime; launchd then starts the installed code.
      const updated = current !== initial && current === candidate;
      candidate = current;
      return updated;
    } catch {
      candidate = undefined;
      return false;
    }
  };
}
