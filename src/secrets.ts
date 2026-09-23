import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function jevApiKey(): Promise<string | undefined> {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-s", "t3threads.typesafe", "-a", userInfo().username, "-w"], { encoding: "utf8", timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    // Command errors can contain credential output; never expose them to callers.
    return undefined;
  }
}
