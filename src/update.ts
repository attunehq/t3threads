import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./client.js";

const exec = promisify(execFile);

export async function update(signal?: AbortSignal) {
  const args = ["install", "--global", "t3threads@latest"];
  try {
    if (process.platform === "win32") {
      // npm is a .cmd shim on Windows, so it must run through cmd.exe.
      await exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { signal, windowsHide: true });
    } else {
      await exec("npm", args, { signal });
    }
  } catch (error) {
    fail("UPDATE_FAILED", `Could not install t3threads@latest: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { status: "updated", package: "t3threads@latest" };
}
