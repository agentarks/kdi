import { closeDb } from "../src/db";
import { rmSync } from "node:fs";

export function cleanupDb(path: string) {
  closeDb();
  try { rmSync(path); } catch {}
  try { rmSync(path + "-wal"); } catch {}
  try { rmSync(path + "-shm"); } catch {}
}
