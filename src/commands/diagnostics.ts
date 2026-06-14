import { Command } from "commander";
import { isEnabled, FF_DIAGNOSTICS } from "../flags";
import { resolveBoard } from "../resolveBoard";
import { runDiagnostics, type DiagnosticSeverity } from "../models/diagnostic";

export const diagnosticsCommand = new Command("diagnostics")
  .description("Run board health diagnostics")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--severity <level>", "Minimum severity: warning, error, critical")
  .option("--task <taskId>", "Restrict diagnostics to a single task id")
  .option("--json", "Output as JSON")
  .action((options: { board?: string; severity?: string; task?: string; json?: boolean }) => {
    try {
      if (!isEnabled(FF_DIAGNOSTICS)) {
        console.error("Diagnostics feature is not enabled.");
        process.exit(1);
      }

      let severity: DiagnosticSeverity | undefined;
      if (options.severity) {
        const normalized = options.severity.toLowerCase();
        if (!["warning", "error", "critical"].includes(normalized)) {
          console.error(`Invalid severity "${options.severity}". Valid: warning, error, critical`);
          process.exit(1);
        }
        severity = normalized as DiagnosticSeverity;
      }

      let taskId: number | undefined;
      if (options.task) {
        taskId = Number(options.task);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          console.error(`Invalid task id "${options.task}".`);
          process.exit(1);
        }
      }

      const boardSlug = resolveBoard(options.board);
      const findings = runDiagnostics(boardSlug, { severity, taskId });

      if (options.json) {
        console.log(JSON.stringify(findings, null, 2));
        return;
      }

      if (findings.length === 0) {
        console.log("No diagnostic findings.");
        return;
      }

      console.log(`Board: ${boardSlug}`);
      console.log(`Findings: ${findings.length}`);
      console.log("");
      for (const f of findings) {
        console.log(`[${f.severity.toUpperCase()}] ${f.rule} (task ${f.task_id})`);
        console.log(`  ${f.message}`);
        if (f.actions.length > 0) {
          console.log(`  actions: ${f.actions.join(", ")}`);
        }
        console.log("");
      }
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
