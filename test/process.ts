import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export async function stopProcess(pid: number) {
  if (process.platform === "win32") {
    // Termination is asynchronous on Windows. Wait on the process handle, not
    // its exit code, before removing files that its SQLite connection owned.
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      try { $worker = [System.Diagnostics.Process]::GetProcessById(${pid}) }
      catch [System.ArgumentException] { exit 0 }
      try {
        $null = $worker.Handle
        if (!$worker.HasExited) { $worker.Kill() }
        if (!$worker.WaitForExit(5000)) { throw 'The detached worker did not exit' }
      } finally { $worker.Dispose() }
    `], { timeout: 10_000 });
    return;
  }
  const running = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const deadline = Date.now() + 5000;
  while (running() && Date.now() < deadline) await delay(50);
  assert.equal(running(), false, "the detached worker must exit before its files are removed");
}
