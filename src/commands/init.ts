import { Command } from "commander";
import { initDb, closeDb, defaultDbPath } from "../db";
import { unlinkSync } from "node:fs";

export const initCommand = new Command("init")
  .description("Initialize the kdi database")
  .option("--force", "Re-run schema and migrations on an existing database")
  .option("--path <path>", "Initialize at a custom path (overrides default resolution)")
  .action((options: { force?: boolean; path?: string }) => {
    try {
      const dbPath = options.path || defaultDbPath();

      if (options.force) {
        closeDb();
        // Delete WAL artifacts so initDb creates a fresh connection
        for (const suffix of ["", "-wal", "-shm"]) {
          const filePath = dbPath + suffix;
          try {
            unlinkSync(filePath);
          } catch {
            /* file may not exist — expected on first --force run */
          }
        }
      }

      initDb(dbPath);
      console.log(`Database initialized at ${dbPath}`);
    } catch (err: any) {
      console.error(`Error: Failed to initialize database: ${err.message}`);
      process.exit(1);
    }
  });
