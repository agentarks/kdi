import { closeDb } from "../src/db";
import { rmSync } from "node:fs";

export function cleanupDb(path: string) {
  closeDb();
  try { rmSync(path); } catch {}
  try { rmSync(path + "-wal"); } catch {}
  try { rmSync(path + "-shm"); } catch {}
  try { rmSync(path + ".init.lock"); } catch {}
}

export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
