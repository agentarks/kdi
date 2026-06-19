#!/usr/bin/env bun
// Run a command with a hard wall-clock timeout. Kills the process tree on timeout.
// Usage: bun _with-timeout.ts <seconds> <command...>
// Captures stdout+stderr. Prints "TIMEOUT" marker and exits 124 on kill.

const timeoutSec = parseInt(process.argv[2], 10);
if (isNaN(timeoutSec) || timeoutSec <= 0) {
  console.error("Usage: _with-timeout.ts <seconds> <command...>");
  process.exit(2);
}

const cmd = process.argv.slice(3);
const proc = Bun.spawn({
  cmd,
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    proc.kill("SIGKILL");
  } catch {}
  // Also try to kill the process group if possible
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {}
}, timeoutSec * 1000);

const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const exitCode = await proc.exited;
clearTimeout(timer);

if (timedOut) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.stderr.write(`\n[_with-timeout] TIMEOUT after ${timeoutSec}s\n`);
  process.exit(124);
} else {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(exitCode);
}
