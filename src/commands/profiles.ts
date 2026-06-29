import { Command } from "commander";
import { isEnabled, FF_REAL_HARNESS_PROFILES } from "../flags";
import { doctorProfiles, bootstrapRealProfiles, defaultProfilesPath } from "../profiles";

function ensureFlag(): void {
  if (!isEnabled(FF_REAL_HARNESS_PROFILES)) {
    console.error("FF_REAL_HARNESS_PROFILES is disabled. Set FF_REAL_HARNESS_PROFILES=true to use this command.");
    process.exit(1);
  }
}

export const profilesCommand = new Command("profiles")
  .description("Manage and validate harness profiles (bootstrap real pi/opencode profiles, doctor the registry)")
  .action(() => {
    profilesCommand.help();
  });

profilesCommand
  .command("doctor")
  .description("Validate every loaded profile's harness binary resolves on PATH")
  .option("--path <path>", "Profiles YAML path (default: $KDI_PROFILES_PATH or ~/.config/kdi/profiles.yaml)")
  .option("--json", "Output a stable JSON report")
  .action((options: { path?: string; json?: boolean }) => {
    ensureFlag();
    try {
      const path = options.path ?? defaultProfilesPath();
      const report = doctorProfiles(path);
      const healthy = report.every((r) => r.ok);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Profiles path: ${path}`);
        for (const r of report) {
          const verdict = r.ok ? "ok" : r.status;
          const pathOrMissing = r.resolved_path ?? "NOT FOUND";
          console.log(`  ${r.name.padEnd(12)} ${verdict.padEnd(14)} ${r.binary} -> ${pathOrMissing}`);
        }
        console.log(healthy ? "\nAll profiles healthy." : "\nOne or more profiles unhealthy.");
      }
      process.exit(healthy ? 0 : 1);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });

profilesCommand
  .command("bootstrap")
  .description("Write known-good real opencode and pi profile entries if absent")
  .option("--path <path>", "Profiles YAML path (default: $KDI_PROFILES_PATH or ~/.config/kdi/profiles.yaml)")
  .option("--force", "Overwrite existing opencode/pi entries")
  .action((options: { path?: string; force?: boolean }) => {
    ensureFlag();
    try {
      const path = options.path ?? defaultProfilesPath();
      const results = bootstrapRealProfiles(path, options.force);
      for (const r of results) {
        console.log(`  ${r.name.padEnd(10)} ${r.action}`);
      }
      console.log(`\nDone. Run "kdi profiles doctor" to validate binaries.`);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });