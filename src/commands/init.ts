import { Command } from "commander";
import { initDb, closeDb, defaultDbPath } from "../db";
import { unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBoard, showBoard } from "../models/board";

export const initCommand = new Command("init")
  .description("Initialize the kdi database")
  .option("--force", "Re-run schema and migrations on an existing database")
  .option("--path <path>", "Initialize at a custom path (overrides default resolution)")
  .action((options: { force?: boolean; path?: string }) => {
    try {
      const dbPath = options.path || defaultDbPath();

      if (options.force) {
        closeDb();
        // Delete transient WAL artifacts so initDb creates a fresh connection.
        // The main database file is intentionally preserved; --force only
        // re-runs schema and migrations.
        for (const suffix of ["-wal", "-shm"]) {
          const filePath = dbPath + suffix;
          try {
            unlinkSync(filePath);
          } catch {
            /* file may not exist — expected on first --force run */
          }
        }
      }

      initDb(dbPath);

      // Ensure a default board exists so board-less commands work immediately.
      const existingDefault = showBoard("default", true);
      if (!existingDefault) {
        const defaultWorkdir = join(dirname(dbPath), "boards", "default");
        mkdirSync(defaultWorkdir, { recursive: true });
        createBoard("default", defaultWorkdir);
      }

      console.log(`Database initialized at ${dbPath}`);
    } catch (err: any) {
      console.error(`Error: Failed to initialize database: ${err.message}`);
      process.exit(1);
    }
  });
