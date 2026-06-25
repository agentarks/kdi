# BRD-KDI-055: Consider Whether Task Changes Should Propagate to Original Repo

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Keep dispatcher worktree isolation intact while making successful task edits easy
for an operator to find and merge. KDI should not silently mutate the original
board workdir after an agent completes a task.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI currently protects the original board workdir by running dispatched agents in
git worktrees, but successful edits can be hard to recover if cleanup removes the
task branch/worktree. Copying changes back automatically would make edits visible
in the original repo, but risks overwriting local work or creating unrequested git
state.

-------------------------------------------------------------------------------
User-Visible Decision Options
-------------------------------------------------------------------------------
1. **Document branch/worktree handoff only:** preserve the successful task
   branch/worktree and show the operator where it is.
2. **Copy changes back to the original workdir:** convenient, but unsafe around
   dirty workdirs and conflicts.
3. **Auto-commit/merge/push:** highest automation, highest surprise; requires
   conflict handling and policy decisions.

-------------------------------------------------------------------------------
Chosen Recommendation
-------------------------------------------------------------------------------
Choose option 1. Do not automatically copy, merge, push, or commit task worktree
changes back into the original board workdir. The handoff artifact is the
task-owned git branch and worktree: `wt/<profile>/<task_id>`. Operators decide
when to inspect, merge, push, or delete it.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Original board workdir | Stays untouched | Stays untouched |
| Successful task with edits | Worktree/branch can be cleaned up | Preserve branch/worktree as handoff |
| Successful task without edits | Cleaned up | May be cleaned up |
| Propagation to original repo | None | None; operator merges/pushes explicitly |
| Operator handoff | Not clearly documented | Completion output/metadata names branch and worktree |

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- Detect whether a successful task worktree contains local changes or commits
  relative to the task base ref before cleanup.
- Preserve the worktree and `wt/<profile>/<task_id>` branch when there is work to
  hand off.
- Continue best-effort cleanup for successful worktrees with no changes or task
  commits.
- Leave the original board workdir untouched.
- Include the preserved branch name and worktree path in operator-facing output,
  task log, task event, or run metadata.
- Do not automatically copy, merge, rebase, push, or create commits.
- Failed, timed-out, rate-limited, and blocked run handoff behavior is out of
  scope for KDI-055.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Register and implement behind `ff_worktree_handoff` / `FF_WORKTREE_HANDOFF`,
default `false`. When disabled, existing cleanup behavior is unchanged.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Automatic copy-back into the original board workdir.
- Automatic merge, rebase, push, or commit creation.
- Conflict resolution workflow.
- New task status.
- Cross-repo patch export format.
- Preserved-worktree garbage collection; that belongs in a later cleanup policy.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] A successful task that changes files or creates commits leaves the
      original board workdir unchanged.
- [ ] The task branch `wt/<profile>/<task_id>` remains available after
      successful completion when there is work to hand off.
- [ ] The task worktree remains available after successful completion when there
      is work to hand off.
- [ ] Operator-facing output or metadata includes the branch and worktree path.
- [ ] A successful task with no git changes may be cleaned up as today.
- [ ] KDI does not automatically copy, merge, push, or commit task changes.
- [ ] The behavior is gated by `FF_WORKTREE_HANDOFF=false` by default.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Future implementation should prove this with a real git repo and isolated
`KDI_DB`:
- task with file edits preserves `wt/<profile>/<task_id>` and leaves the original
  workdir clean;
- task with no edits follows existing cleanup;
- `FF_WORKTREE_HANDOFF=false` keeps current cleanup behavior.

-------------------------------------------------------------------------------
Future Option
-------------------------------------------------------------------------------
If users later need automatic propagation, add a separate explicit command such
as `kdi apply <task_id>` or `kdi complete --apply-to-workdir`. That command must
check for dirty workdirs, detect conflicts, and require deliberate operator
action. It is not part of KDI-055.
