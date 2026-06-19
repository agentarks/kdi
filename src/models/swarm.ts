import { getDb } from "../db";
import { createTask, type CreateTaskInput, type Task } from "./task";
import { addDependency } from "./dependency";
import { addEvent } from "./taskEvent";

const WORKER_PATTERN = /^[^:]+:.+$/;

export interface SwarmWorkerInput {
  profile: string;
  title: string;
}

export interface SwarmInput {
  board_id: number;
  workers: SwarmWorkerInput[];
  verifier: string;
  synthesizer: string;
  body?: string;
  workspace_kind?: "dir" | "worktree" | "scratch";
  workspace?: string;
  session_id?: string;
  priority?: number;
}

export interface SwarmGraph {
  orchestrator_id: number;
  worker_ids: number[];
  verifier_id: number;
  synthesizer_id: number;
}

export interface SwarmPlanTask {
  title: string;
  assignee: string | null;
  status: Task["status"];
}

export interface SwarmPlan {
  orchestrator: SwarmPlanTask;
  workers: SwarmPlanTask[];
  verifier: SwarmPlanTask;
  synthesizer: SwarmPlanTask;
}

export function validateSwarmInput(input: SwarmInput): void {
  if (!input.workers || input.workers.length === 0) {
    throw new Error("At least one --worker is required.");
  }

  const trimmedVerifier = input.verifier?.trim();
  if (!trimmedVerifier) {
    throw new Error("--verifier is required.");
  }

  const trimmedSynthesizer = input.synthesizer?.trim();
  if (!trimmedSynthesizer) {
    throw new Error("--synthesizer is required.");
  }

  const titles = new Set<string>();
  for (const worker of input.workers) {
    const value = `${worker.profile}:${worker.title}`;
    if (!WORKER_PATTERN.test(value)) {
      throw new Error(`Invalid worker "${value}". Use --worker <profile>:<title>.`);
    }
    if (titles.has(worker.title)) {
      throw new Error(`Duplicate worker title "${worker.title}". Worker titles must be unique within a swarm.`);
    }
    titles.add(worker.title);
  }
}

function makeOrchestratorSlug(firstWorkerTitle: string): string {
  const now = Math.floor(Date.now() / 1000);
  const safe = firstWorkerTitle.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return `${safe}-${now}`;
}

function commonTaskFields(input: SwarmInput): Pick<CreateTaskInput, "body" | "priority" | "workspace_kind" | "workspace" | "session_id"> {
  return {
    body: input.body,
    priority: input.priority,
    workspace_kind: input.workspace_kind,
    workspace: input.workspace,
    session_id: input.session_id,
  };
}

export function planSwarmGraph(input: SwarmInput): SwarmPlan {
  validateSwarmInput(input);

  const slug = makeOrchestratorSlug(input.workers[0].title);
  const orchestrator: SwarmPlanTask = {
    title: `swarm: ${slug}`,
    assignee: null,
    status: "triage",
  };

  const workers: SwarmPlanTask[] = input.workers.map((worker) => ({
    title: worker.title,
    assignee: worker.profile,
    status: "ready",
  }));

  const verifier: SwarmPlanTask = {
    title: `verify: ${slug}`,
    assignee: input.verifier.trim(),
    status: "ready",
  };

  const synthesizer: SwarmPlanTask = {
    title: `synthesize: ${slug}`,
    assignee: input.synthesizer.trim(),
    status: "ready",
  };

  return { orchestrator, workers, verifier, synthesizer };
}

export function createSwarmGraph(input: SwarmInput): SwarmGraph {
  validateSwarmInput(input);

  const db = getDb();
  const slug = makeOrchestratorSlug(input.workers[0].title);
  const orchestratorTitle = `swarm: ${slug}`;
  const base = commonTaskFields(input);

  const graph = db.transaction(() => {
    const orchestrator = createTask({
      board_id: input.board_id,
      title: orchestratorTitle,
      ...base,
      initialStatus: "triage",
    });

    addEvent(orchestrator.id, "swarm_created", { worker_count: input.workers.length });

    const workerIds: number[] = [];
    for (const worker of input.workers) {
      const task = createTask({
        board_id: input.board_id,
        title: worker.title,
        assignee: worker.profile,
        ...base,
        initialStatus: "ready",
        swarm_parent_id: orchestrator.id,
      });
      workerIds.push(task.id);
      addEvent(task.id, "swarm_worker_created", { orchestrator_id: orchestrator.id, title: worker.title, profile: worker.profile });
    }

    const verifier = createTask({
      board_id: input.board_id,
      title: `verify: ${slug}`,
      assignee: input.verifier.trim(),
      ...base,
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });
    addEvent(verifier.id, "swarm_verifier_created", { orchestrator_id: orchestrator.id });

    for (const workerId of workerIds) {
      addDependency(workerId, verifier.id);
    }

    const synthesizer = createTask({
      board_id: input.board_id,
      title: `synthesize: ${slug}`,
      assignee: input.synthesizer.trim(),
      ...base,
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });
    addEvent(synthesizer.id, "swarm_synthesizer_created", { orchestrator_id: orchestrator.id });
    addDependency(verifier.id, synthesizer.id);

    return {
      orchestrator_id: orchestrator.id,
      worker_ids: workerIds,
      verifier_id: verifier.id,
      synthesizer_id: synthesizer.id,
    };
  });

  return graph();
}
