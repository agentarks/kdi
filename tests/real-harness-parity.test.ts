import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KDI_REAL_HARNESS_TEST === "true";

if (!ENABLED) {
  describe("real harness parity", () => {
    it("skips without KDI_REAL_HARNESS_TEST=true", () => {
      expect(true).toBe(true);
    });
  });
} else {
  const repoRoot = process.cwd();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function runKdi(args: string[], env: NodeJS.ProcessEnv): string {
    return execFileSync("bun", ["run", "src/index.ts", ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
  }

  function parseWorktreePath(output: string, branch: string): string | undefined {
    for (const block of output.trim().split(/\n\s*\n/)) {
      const [, path] = block.match(/^worktree (.+)$/m) ?? [];
      if (path && block.includes(`refs/heads/${branch}`)) {
        return path;
      }
    }
    return undefined;
  }

  async function findWorktreePath(
    repoDir: string,
    branch: string,
    timeoutMs = 10000,
    intervalMs = 150
  ): Promise<string> {
    const start = Date.now();
    while (true) {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        encoding: "utf-8",
      });
      const path = parseWorktreePath(output, branch);
      if (path !== undefined) {
        return path;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Worktree for branch ${branch} not found in ${repoDir}`);
      }
      await sleep(intervalMs);
    }
  }

  async function waitForStatus(
    taskId: number,
    status: string,
    env: NodeJS.ProcessEnv,
    timeoutMs = 30000
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const out = runKdi(["show", String(taskId)], env);
      if (out.includes(`Status: ${status}`)) {
        return out;
      }
      await sleep(500);
    }
    throw new Error(`Timeout waiting for task ${taskId} to reach ${status}`);
  }

  describe("real harness parity", () => {
    const TMP = mkdtempSync(join(tmpdir(), "kdi-real-harness-"));
    const HOME = join(TMP, "home");
    const REPO = join(TMP, "repo");
    const DB = join(TMP, "kdi.db");
    const SENTINEL = join(TMP, "harness-sentinel");
    const BIN = join(HOME, "bin");
    let dispatchProc: ReturnType<typeof spawn> | undefined;

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME,
      KDI_DB: DB,
      KDI_HARNESS_SENTINEL: SENTINEL,
      PATH: `${BIN}${process.env.PATH ? ":" + process.env.PATH : ""}`,
      FF_ENABLE_KANBAN_DISPATCH: "true",
      FF_HARNESS_CONTEXT: "true",
    };

    beforeAll(() => {
      mkdirSync(HOME, { recursive: true });
      mkdirSync(BIN, { recursive: true });
      mkdirSync(REPO, { recursive: true });

      const opencodePath = join(BIN, "opencode");
      const script = `#!/bin/bash
set -euo pipefail
printf 'title=%s\\nbody=%s\\nid=%s\\nboard=%s\\n' "$KDI_TASK_TITLE" "$KDI_TASK_BODY" "$KDI_TASK_ID" "$KDI_BOARD" > .kdi-harness-marker
echo "Parity result: $KDI_TASK_TITLE ($KDI_BOARD#$KDI_TASK_ID)"
while [ ! -f "${SENTINEL}" ]; do sleep 0.1; done
`;
      writeFileSync(opencodePath, script, "utf-8");
      chmodSync(opencodePath, 0o755);

      execFileSync("git", ["init"], { cwd: REPO, env: baseEnv });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: REPO,
        env: baseEnv,
      });
      execFileSync("git", ["config", "user.name", "Test User"], {
        cwd: REPO,
        env: baseEnv,
      });
      writeFileSync(join(REPO, "README.md"), "# repo\n", "utf-8");
      execFileSync("git", ["add", "."], { cwd: REPO, env: baseEnv });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: REPO,
        env: baseEnv,
      });
    });

    afterAll(() => {
      if (dispatchProc && !dispatchProc.killed) {
        dispatchProc.kill("SIGTERM");
      }
      rmSync(TMP, { recursive: true, force: true });
    });

    it("runs a real harness end-to-end and receives task context", async () => {
      runKdi(["init"], baseEnv);
      runKdi(["boards", "create", "myproj", "--workdir", REPO], baseEnv);

      const createOut = runKdi(
        [
          "create",
          "Parity task",
          "--body",
          "Verify harness context",
          "--board",
          "myproj",
          "--assignee",
          "opencode",
        ],
        baseEnv
      );
      const taskId = parseInt(createOut.trim().split("\n")[0], 10);
      expect(taskId).toBeGreaterThan(0);

      runKdi(["promote", String(taskId)], baseEnv);

      dispatchProc = spawn("bun", ["run", "src/index.ts", "dispatch"], {
        cwd: repoRoot,
        env: baseEnv,
        stdio: "pipe",
      });

      await waitForStatus(taskId, "running", baseEnv);

      const branch = `wt/opencode/${taskId}`;
      const worktreePath = await findWorktreePath(REPO, branch);
      const markerPath = join(worktreePath, ".kdi-harness-marker");

      // The harness may still be starting; wait for it to write the marker.
      const markerStart = Date.now();
      while (!existsSync(markerPath)) {
        if (Date.now() - markerStart > 10000) {
          throw new Error(`Harness marker not found at ${markerPath}`);
        }
        await sleep(100);
      }

      const marker = readFileSync(markerPath, "utf-8");
      expect(marker).toContain("title=Parity task");
      expect(marker).toContain("body=Verify harness context");
      expect(marker).toContain(`id=${taskId}`);
      expect(marker).toContain("board=myproj");

      writeFileSync(SENTINEL, "", "utf-8");

      await waitForStatus(taskId, "done", baseEnv);

      if (dispatchProc && !dispatchProc.killed) {
        dispatchProc.kill("SIGTERM");
        await sleep(500);
        if (!dispatchProc.killed) {
          dispatchProc.kill("SIGKILL");
        }
      }

      const finalOut = runKdi(["show", String(taskId)], baseEnv);
      expect(finalOut).toContain("Parity result: Parity task (myproj#");
    });
  });
}
