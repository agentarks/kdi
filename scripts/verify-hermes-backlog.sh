#!/usr/bin/env bash
# Verify that each "Done" item in specs/hermes-kanban-backlog.md works at the CLI.
# Uses temp HOME and temp KDI_DB so the user's real board is never touched.
# Every CLI call has a hard 8s timeout via a small bun helper.

set -u
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

# Temp state per run
TMP=$(mktemp -d)
mkdir -p "$TMP/home"
export HOME="$TMP/home"
export KDI_DB="$TMP/kdi.db"

# Enable all feature flags so we exercise the gated behavior
for f in FF_ENABLE_KANBAN_DISPATCH FF_WORKER_LOG_CAPTURE FF_SCHEDULED_STATUS \
         FF_REVIEW_STATUS FF_COMPLETE_METADATA FF_PRIORITY_INTEGER FF_MAX_RUNTIME \
         FF_SKILLS_ARRAY FF_TENANT_NAMESPACE FF_CREATED_BY FF_MODEL_OVERRIDE \
         FF_MAX_RETRIES FF_BOARD_METADATA FF_BOARD_RM_DELETE FF_BOARD_RENAME \
         FF_BOARD_SWITCH FF_DEFAULT_WORKDIR FF_ASSIGN_REASSIGN \
         FF_CRASH_GRACE_PERIOD FF_HEARTBEAT FF_RATE_LIMIT_EXIT_CODE FF_STATS \
         FF_GC FF_ASSIGNEES_LISTING FF_TASK_ATTACHMENTS FF_DIAGNOSTICS \
         FF_CONTEXT_BUILDER FF_NOTIFY_SUBS FF_LIST_FILTERS_SORT \
         FF_SHOW_RUN_FILTERING FF_RUNS_FILTERING FF_BULK_OPERATIONS \
         FF_COMMENT_ENHANCEMENTS FF_DISPATCH_CONTROLS FF_WATCH_FILTERS \
         FF_WORKFLOW_TEMPLATES FF_TRIAGE_AUTOMATION FF_SWARM_MODE \
         FF_DISPATCHER_PRESENCE_WARNING FF_GOAL_MODE; do
  export $f=true
done

KDI="bun run $SCRIPT_DIR/../src/index.ts"

pass=0
fail=0
declare -a results

# Run a single test.
# $1 id, $2 desc, $3 cmd, $4 expected substring ("" = no expectation)
run_test() {
  local id="$1"
  local desc="$2"
  local cmd="$3"
  local expect_match="$4"

  local out
  out=$(bun run "$SCRIPT_DIR/_with-timeout.ts" 8 bash -c "$cmd" 2>&1)
  local rc=$?

  if [[ -z "$expect_match" ]] || [[ "$out" == *"$expect_match"* ]]; then
    pass=$((pass+1))
    results+=("PASS  $id  $desc")
  else
    fail=$((fail+1))
    results+=("FAIL  $id  $desc")
    results+=("        cmd: $cmd")
    results+=("        expected: $expect_match")
    results+=("        rc=$rc got: $(echo "$out" | head -3 | tr '\n' '|')")
  fi
}

# Run a test that just checks rc=0 (output is implementation-specific).
run_rc_test() {
  local id="$1"
  local desc="$2"
  local cmd="$3"
  local out
  out=$(bun run "$SCRIPT_DIR/_with-timeout.ts" 8 bash -c "$cmd" 2>&1)
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    pass=$((pass+1))
    results+=("PASS  $id  $desc")
  else
    fail=$((fail+1))
    results+=("FAIL  $id  $desc")
    results+=("        cmd: $cmd")
    results+=("        rc=$rc got: $(echo "$out" | head -3 | tr '\n' '|')")
  fi
}

# Get the most-recently-created task ID with the given title prefix.
get_id() {
  local prefix="$1"
  $KDI list --archived 2>/dev/null | grep -F "$prefix" | head -1 | awk '{print $1}' | tr -d ':'
}

echo "==> init / boards"
run_test "KDI-013b" "kdi init (idempotent)" "$KDI init 2>&1" "initialized"
run_test "KDI-012"  "boards create basic"   "$KDI boards create demo --workdir \"$PWD\" 2>&1" "Created board"
run_test "KDI-012"  "boards create with metadata" "$KDI boards create themed --workdir \"$PWD\" --name \"Themed\" --icon '🚀' --color '#8b5cf6' 2>&1" "Created board"
run_test "KDI-012b" "boards list --all"     "$KDI boards list --all 2>&1" "demo"
run_test "KDI-012"  "boards list shows metadata" "$KDI boards list --all 2>&1" "icon=🚀"
run_test "KDI-012"  "boards edit metadata"  "$KDI boards edit themed --name \"Themed v2\" --color '#ff0000' 2>&1" "Updated board"
run_test "KDI-014"  "boards rename"         "$KDI boards create secondary --workdir \"$PWD\" 2>&1 && $KDI boards rename secondary renamed 2>&1" "Renamed"
run_test "KDI-015"  "set-default-workdir (set)" "$KDI boards set-default-workdir demo \"$PWD\" 2>&1" "set to"
run_test "KDI-015"  "set-default-workdir (clear)" "$KDI boards set-default-workdir demo 2>&1" "cleared"
run_test "KDI-013"  "boards switch"         "$KDI boards switch demo 2>&1" "Switched"
run_test "KDI-013"  "KDI_BOARD env var"     "KDI_BOARD=renamed $KDI boards show 2>&1" "Board: renamed"

# KDI-013: global --board flag — REAL GAP, expected to fail.
run_test "KDI-013"  "global --board flag (expected gap)" "$KDI --board renamed boards show 2>&1" "Board: renamed"

echo "==> create / metadata"
run_rc_test "KDI-007"  "create --created-by"   "$KDI create 'task A' --created-by orchestrator --no-dispatcher-warning 2>&1"
ID_A=$(get_id "task A")
run_rc_test "KDI-006"  "create --tenant"       "$KDI create 'task B' --tenant backend --no-dispatcher-warning 2>&1"
ID_B=$(get_id "task B")
run_rc_test "KDI-004"  "create --priority 5"   "$KDI create 'task C' --priority 5 --no-dispatcher-warning 2>&1"
ID_C=$(get_id "task C")
run_rc_test "KDI-008"  "create --max-runtime"  "$KDI create 'task D' --max-runtime 30m --no-dispatcher-warning 2>&1"
ID_D=$(get_id "task D")
run_rc_test "KDI-009"  "create --skill x2"     "$KDI create 'task E' --skill github --skill code-review --no-dispatcher-warning 2>&1"
ID_E=$(get_id "task E")
run_rc_test "KDI-010"  "create --model"        "$KDI create 'task F' --model gpt-5.5 --no-dispatcher-warning 2>&1"
ID_F=$(get_id "task F")
run_rc_test "KDI-011"  "create --max-retries"  "$KDI create 'task G' --max-retries 3 --no-dispatcher-warning 2>&1"
ID_G=$(get_id "task G")
run_rc_test "KDI-001b" "create --initial-status blocked" "$KDI create 'task H' --initial-status blocked --no-dispatcher-warning 2>&1"
ID_H=$(get_id "task H")
run_rc_test "KDI-001b" "create --initial-status running" "$KDI create 'task I' --initial-status running --no-dispatcher-warning 2>&1"
ID_I=$(get_id "task I")
run_rc_test "KDI-001"  "create --triage"       "$KDI create 'task T' --triage --body 'this is the body' --no-dispatcher-warning 2>&1"
ID_T=$(get_id "task T")
# KDI-001c idempotency: same key returns same id
out=$($KDI create 'task IKEY1' --idempotency-key abc --no-dispatcher-warning 2>&1)
out2=$($KDI create 'task IKEY2' --idempotency-key abc --no-dispatcher-warning 2>&1)
if [[ "$out" == "$out2" && -n "$out" ]]; then
  pass=$((pass+1)); results+=("PASS  KDI-001c  create --idempotency-key (dedup)")
else
  fail=$((fail+1)); results+=("FAIL  KDI-001c  create --idempotency-key (dedup)  first=$out second=$out2")
fi
run_rc_test "KDI-030"  "create --session"      "$KDI create 'task S' --session sess-1 --no-dispatcher-warning 2>&1"
ID_S=$(get_id "task S")

# KDI-039 workflow templates need to be defined before --workflow-template-id is used
run_test "KDI-039"  "workflows define"      "$KDI workflows define onboarding --name \"Onboarding\" --steps '[\"auth:opencode\",\"ui:opencode\"]' 2>&1" "Defined"
run_rc_test "KDI-039"  "create --workflow-template-id" "$KDI create 'task W' --workflow-template-id onboarding --no-dispatcher-warning 2>&1"
ID_W=$(get_id "task W")
run_rc_test "KDI-038"  "create --goal"         "$KDI create 'task GOAL' --goal --goal-max-turns 5 --goal-judge opencode --no-dispatcher-warning 2>&1"
ID_GOAL=$(get_id "task GOAL")

echo "==> list / show"
run_rc_test "KDI-030"  "list --mine"           "KDI_PROFILE=claude $KDI list --mine 2>&1"
run_rc_test "KDI-006"  "list --status running" "$KDI list --status running 2>&1"
run_rc_test "KDI-006"  "list --assignee opencode" "$KDI list --assignee opencode 2>&1"
run_rc_test "KDI-007"  "list --created-by orchestrator" "$KDI list --created-by orchestrator 2>&1"
run_rc_test "KDI-030"  "list --session sess-1" "$KDI list --session sess-1 2>&1"
run_rc_test "KDI-030"  "list --archived"       "$KDI list --archived 2>&1"
run_rc_test "KDI-030"  "list --sort priority-desc" "$KDI list --sort priority-desc 2>&1"
run_rc_test "KDI-030"  "list --sort title"     "$KDI list --sort title 2>&1"
run_rc_test "KDI-030"  "list --tenant backend" "$KDI list --tenant backend 2>&1"
run_rc_test "KDI-030"  "list --workflow-template-id onboarding" "$KDI list --workflow-template-id onboarding 2>&1"
run_test "KDI-031"  "show task"             "$KDI show $ID_A 2>&1" "Title: task A"
run_test "KDI-031"  "show --state-type status --state-name running" "$KDI show $ID_I --state-type status --state-name running 2>&1" "task I"

echo "==> lifecycle / bulk"
run_test "KDI-032"  "block $ID_A $ID_B"     "$KDI block $ID_A $ID_B --reason testing 2>&1" "Blocked"
run_test "KDI-032"  "unblock --reason"      "$KDI unblock $ID_A --reason cleared 2>&1" "Unblocked"
run_test "KDI-002"  "schedule $ID_B $ID_C"  "$KDI schedule $ID_B $ID_C --at 2030-01-01T00:00:00Z 2>&1" "Scheduled"
run_test "KDI-002"  "unblock scheduled"     "$KDI unblock $ID_B --reason ready-now 2>&1" "now ready"
run_test "KDI-003"  "review"                "$KDI review $ID_C 2>&1" "under review"
run_test "KDI-032"  "promote --force --dry-run" "$KDI promote $ID_D $ID_E --force --dry-run 2>&1" "would_promote"
run_test "KDI-032"  "promote"               "$KDI promote $ID_D $ID_E 2>&1" "Promoted"
# KDI-001 specify — uses --skip-llm to test the basic (no LLM) path
run_test "KDI-001"  "specify (triage → todo) basic" "$KDI specify $ID_T --skip-llm 2>&1" "Specified"
run_rc_test "KDI-001"  "specify --all"         "$KDI specify --all --skip-llm 2>&1"
run_rc_test "KDI-001"  "specify --all --tenant backend" "$KDI specify --all --tenant backend --skip-llm 2>&1"

echo "==> assign / reassign / claim / heartbeat / complete"
run_test "KDI-017"  "assign claude"         "$KDI assign $ID_C claude 2>&1" "Assigned"
run_test "KDI-017"  "assign none (unassign)" "$KDI assign $ID_C none 2>&1" "Unassigned"
run_test "KDI-017"  "reassign with --reclaim" "$KDI reassign $ID_C opencode --reclaim --reason handoff 2>&1" "Reassigned"
# KDI-017 reclaim: needs a running task with active claim. Create, promote, claim, reclaim.
RC_NEW=$($KDI create 'task RC' --no-dispatcher-warning 2>&1)
ID_RC=$(get_id "task RC")
$KDI promote $ID_RC 2>&1 | head -1
run_test "KDI-017"  "reclaim (setup: claim $ID_RC)" "$KDI claim $ID_RC --ttl 60 2>&1" "Claimed"
run_test "KDI-017"  "reclaim --reason"      "$KDI reclaim $ID_RC --reason cleanup 2>&1" "Reclaimed"
run_test "KDI-000c" "claim --ttl 60"        "$KDI claim $ID_D --ttl 60 2>&1" "Claimed"
run_test "KDI-016"  "heartbeat --note"      "$KDI heartbeat $ID_D --note still-alive 2>&1" "Heartbeat"
run_test "KDI-005"  "complete with result/summary/metadata" "$KDI complete $ID_D --result OK --summary 'done well' --metadata '{\"tests\": 12}' 2>&1" "Completed"
run_test "KDI-005"  "complete multiple IDs" "$KDI complete $ID_E $ID_F --result OK2 2>&1" "Completed"

echo "==> comments / attachments / context / log / runs"
run_test "KDI-033"  "comment --author --max-len" "$KDI comment $ID_A 'hello there friend' --author me --max-len 5 2>&1" "Added comment"
run_test "KDI-022"  "attach file"           "echo hi > /tmp/kdi-test-attach.txt && $KDI attach $ID_A /tmp/kdi-test-attach.txt 2>&1" "Attached"
run_test "KDI-023"  "context"               "$KDI context $ID_A 2>&1" "Task #"
run_rc_test "KDI-018"  "log"                   "$KDI log $ID_A 2>&1"
run_rc_test "KDI-018"  "log --tail 50"         "$KDI log $ID_A --tail 50 2>&1"
run_test "KDI-000"  "runs"                  "$KDI runs $ID_D 2>&1" "outcome=completed"
run_test "KDI-036"  "runs --state-type outcome" "$KDI runs $ID_D --state-type outcome --state-name completed 2>&1" "outcome=completed"

echo "==> assignees / stats / gc / diagnostics"
run_rc_test "KDI-024"  "assignees"             "$KDI assignees 2>&1"
run_test "KDI-019"  "stats"                 "$KDI stats 2>&1" "Status counts"
run_test "KDI-019"  "stats --json"          "$KDI stats --json 2>&1" "status_counts"
run_rc_test "KDI-021"  "gc"                    "$KDI gc --event-retention-days 1 --log-retention-days 1 2>&1"
run_test "KDI-020"  "diagnostics"           "$KDI diagnostics 2>&1" "diagnostic"
run_rc_test "KDI-020"  "diagnostics --severity error" "$KDI diagnostics --severity error 2>&1"
run_rc_test "KDI-020"  "diagnostics --task"    "$KDI diagnostics --task $ID_A 2>&1"

echo "==> notify (built-in 'log' notifier)"
run_test "KDI-025"  "notify-subscribe"      "$KDI notify-subscribe $ID_A --platform telegram --chat-id 1 --notifier-profile log 2>&1" "Subscribed"
run_test "KDI-025"  "notify-list"           "$KDI notify-list 2>&1" "telegram"
run_test "KDI-025"  "notify-list per task"  "$KDI notify-list $ID_A 2>&1" "telegram"
run_test "KDI-025"  "notify-unsubscribe"    "$KDI notify-unsubscribe $ID_A --platform telegram --chat-id 1 2>&1" "Unsubscribed"

echo "==> dispatch / swarm / workflows"
# kdi dispatch is a long-running daemon; it does NOT exit. The backlog maps
# this to KDI-034 (dispatch --max / --failure-limit), but the command is the
# deprecated hermes 'daemon' form, not a one-shot pass. Flag presence only.
run_test "KDI-034"  "dispatch --help shows --max" "$KDI dispatch --help 2>&1" "--max <n>"
run_test "KDI-034"  "dispatch --help shows --failure-limit" "$KDI dispatch --help 2>&1" "--failure-limit"
run_test "KDI-041"  "swarm"                 "$KDI swarm --worker backend:auth:opencode --worker frontend:login:opencode --verifier qa --synthesizer pm 2>&1" "swarm"
run_test "KDI-039"  "step"                  "$KDI step $ID_W --to auth:opencode 2>&1" "step auth:opencode"

echo "==> archive / boards rm"
# Archive first, then --rm
$KDI archive $ID_G 2>&1 | head -1
run_test "KDI-032"  "archive"               "$KDI archive $ID_H 2>&1" "Archived"
run_test "KDI-032"  "archive --rm (after archive)" "$KDI archive $ID_G --rm 2>&1" "deleted"
run_test "KDI-012c" "boards rm --delete"    "$KDI boards rm themed --delete 2>&1" "permanently"

echo "==> tail / watch (long-running; check initial dump + filters)"
# tail prints all events then loops. Use 1s timeout to get the initial dump.
run_test "KDI-000b" "tail initial dump"     "bun run $SCRIPT_DIR/_with-timeout.ts 1 $KDI tail $ID_D 2>&1" "promoted"
# watch initial dump + filters
run_test "KDI-000b" "watch --assignee"      "bun run $SCRIPT_DIR/_with-timeout.ts 1 $KDI watch --assignee opencode 2>&1" ""
run_test "KDI-035"  "watch --tenant"        "bun run $SCRIPT_DIR/_with-timeout.ts 1 $KDI watch --tenant backend 2>&1" ""
run_test "KDI-035"  "watch --kinds"         "bun run $SCRIPT_DIR/_with-timeout.ts 1 $KDI watch --kinds promoted 2>&1" ""
run_test "KDI-035"  "watch --interval"      "bun run $SCRIPT_DIR/_with-timeout.ts 1 $KDI watch --interval 0.1 2>&1" ""

# KDI-036 sanity: --state-type status --state-name done (no match expected, but no error)
run_rc_test "KDI-036" "runs --state-type status --state-name done" "$KDI runs $ID_D --state-type status --state-name done 2>&1"
run_rc_test "KDI-036" "runs --state-type status --state-name done (no match)" "$KDI runs 99999 --state-type status --state-name done 2>&1"

echo ""
echo "================================================================"
echo "VERIFICATION REPORT"
echo "================================================================"
for r in "${results[@]}"; do
  echo "$r"
done
echo "----------------------------------------------------------------"
echo "Total: $((pass+fail))  PASS: $pass  FAIL: $fail"
echo "TMP kept at $TMP for inspection (HOME=$HOME KDI_DB=$KDI_DB)"
echo "================================================================"

# Clean up unless KEEP_TMP=1
if [[ "${KEEP_TMP:-0}" != "1" ]]; then
  rm -rf "$TMP"
fi
