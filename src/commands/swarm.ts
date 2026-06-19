import { Command } from "commander";
import { isEnabled, FF_SWARM_MODE } from "../flags";
import { resolveBoard } from "../resolveBoard";
import { showBoard } from "../models/board";
import { createSwarmGraph, planSwarmGraph, type SwarmWorkerInput } from "../models/swarm";

const VALID_KINDS = ["dir", "worktree", "scratch"] as const;

type Kind = typeof VALID_KINDS[number];

function isValidKind(value: string): value is Kind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

function parseWorker(value: string, previous: SwarmWorkerInput[] = []): SwarmWorkerInput[] {
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`Invalid worker "${value}". Use --worker <profile>:<title>.`);
  }
  const profile = value.slice(0, idx).trim();
  const title = value.slice(idx + 1).trim();
  if (!profile || !title) {
    throw new Error(`Invalid worker "${value}". Profile and title must be non-empty.`);
  }
  return previous.concat({ profile, title });
}

function parsePriority(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid --priority "${value}". Must be an integer.`);
  }
  return parseInt(trimmed, 10);
}

export const swarmCommand = new Command("swarm")
  .description("Create a multi-agent swarm task graph")
  .option("--worker <profile:title>", "Repeatable worker profile:title", parseWorker, [])
  .option("--verifier <profile>", "Verifier profile")
  .option("--synthesizer <profile>", "Synthesizer profile")
  .option("--board <slug>", "Board slug (resolved via chain)")
  .option("--body <text>", "Shared task body")
  .option("--workspace <path>", "Shared workspace path")
  .option("--session <id>", "Shared session id")
  .option("--priority <n>", "Shared priority", parsePriority)
  .option("--kind <kind>", "Workspace kind (dir, worktree, scratch)")
  .option("--dry-run", "Print the planned graph without creating tasks")
  .action((options: {
    worker: SwarmWorkerInput[];
    verifier?: string;
    synthesizer?: string;
    board?: string;
    body?: string;
    workspace?: string;
    session?: string;
    priority?: number;
    kind?: string;
    dryRun?: boolean;
  }) => {
    try {
      if (!isEnabled(FF_SWARM_MODE)) {
        console.error("Swarm mode is not enabled.");
        process.exit(1);
      }

      if (options.kind !== undefined && !isValidKind(options.kind)) {
        console.error(`Invalid --kind "${options.kind}". Valid: ${VALID_KINDS.join(", ")}.`);
        process.exit(1);
      }

      const boardSlug = resolveBoard(options.board);
      const board = showBoard(boardSlug, false);
      if (!board) {
        console.error(`Board "${boardSlug}" not found or is archived.`);
        process.exit(1);
      }

      const input = {
        board_id: board.id,
        workers: options.worker,
        verifier: options.verifier ?? "",
        synthesizer: options.synthesizer ?? "",
        body: options.body,
        workspace_kind: options.kind as Kind | undefined,
        workspace: options.workspace,
        session_id: options.session,
        priority: options.priority,
      };

      if (options.dryRun) {
        const plan = planSwarmGraph(input);
        console.log(`Orchestrator: ${plan.orchestrator.title} (status: ${plan.orchestrator.status})`);
        for (const worker of plan.workers) {
          console.log(`Worker: ${worker.title} (assignee: ${worker.assignee}, status: ${worker.status})`);
        }
        console.log(`Verifier: ${plan.verifier.title} (assignee: ${plan.verifier.assignee}, status: ${plan.verifier.status})`);
        console.log(`Synthesizer: ${plan.synthesizer.title} (assignee: ${plan.synthesizer.assignee}, status: ${plan.synthesizer.status})`);
        console.log("Dependencies:");
        for (const worker of plan.workers) {
          console.log(`  ${worker.title} -> ${plan.verifier.title}`);
        }
        console.log(`  ${plan.verifier.title} -> ${plan.synthesizer.title}`);
        return;
      }

      const graph = createSwarmGraph(input);
      console.log(`Created swarm orchestrator #${graph.orchestrator_id}`);
      console.log(`  workers: ${graph.worker_ids.join(", ")}`);
      console.log(`  verifier: ${graph.verifier_id}`);
      console.log(`  synthesizer: ${graph.synthesizer_id}`);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
