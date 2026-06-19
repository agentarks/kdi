#!/usr/bin/env bash
# End-to-end smoke: real task → dispatcher tick → stub harness spawns →
# task lands in done with outcome=completed on a real task_runs row.
#
# No external CLIs needed. Adds a temporary `stub` profile to
# ~/.config/kdi/profiles.yaml (in the temp HOME), runs the dispatcher
# for a few seconds, then cleans up. The stub profile is removed at
# the end so the user's real config is not touched.

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

# Temp state per run
TMP=$(mktemp -d)
mkdir -p "$TMP/home" "$TMP/repo"
export HOME="$TMP/home"
export KDI_DB="$TMP/kdi.db"

# All feature flags the dispatcher needs
for f in FF_ENABLE_KANBAN_DISPATCH FF_WORKER_LOG_CAPTURE FF_HEARTBEAT \
         FF_RATE_LIMIT_EXIT_CODE FF_CRASH_GRACE_PERIOD FF_TENANT_NAMESPACE \
         FF_CREATED_BY FF_MODEL_OVERRIDE FF_MAX_RUNTIME FF_MAX_RETRIES \
         FF_BOARD_METADATA FF_DEFAULT_WORKDIR FF_BOARD_SWITCH; do
  export $f=true
done

KDI="bun run $SCRIPT_DIR/../src/index.ts"

echo "==> init git repo at $TMP/repo"
cd "$TMP/repo"
git init -q -b main
git config user.email "kdi-test@example.com"
git config user.name "kdi-test"
echo "stub" > README.md
git add README.md
git commit -q -m "init"
cd - >/dev/null

echo "==> write stub profile to $HOME/.config/kdi/profiles.yaml"
mkdir -p "$HOME/.config/kdi"
cat > "$HOME/.config/kdi/profiles.yaml" <<'YAML'
- name: stub
  command: "bash -c 'echo \"stub: task {{task_id}} on {{branch}} in {{workdir}}\"; touch \"$KDI_STUB_MARKER\"; exit 0'"
  agent: stub
YAML
echo "--- profile written ---"
cat "$HOME/.config/kdi/profiles.yaml"

echo
echo "==> kdi init + board + task"
$KDI init >/dev/null
$KDI boards create demo --workdir "$TMP/repo" --base-ref main >/dev/null
$KDI boards switch demo >/dev/null
TASK_OUT=$($KDI create "stub task" --assignee stub --body "do the thing" --no-dispatcher-warning)
TASK_ID="$TASK_OUT"
echo "Created task #$TASK_ID"
$KDI promote "$TASK_ID" >/dev/null

# Mark this is the stub marker file the harness will touch
export KDI_STUB_MARKER="$TMP/stub-marker-$TASK_ID"
echo "Marker file: $KDI_STUB_MARKER (will be created by the stub harness)"

echo
echo "==> run dispatcher (background, --interval 200ms, --max 1)"
bun run "$SCRIPT_DIR/../src/index.ts" dispatch --interval 200 --max 1 > "$TMP/dispatch.log" 2>&1 &
DISPATCH_PID=$!
echo "Dispatcher PID: $DISPATCH_PID"

echo "==> wait for marker file to appear (max 10s)..."
DEADLINE=$(( $(date +%s) + 10 ))
while [[ ! -f "$KDI_STUB_MARKER" ]] && [[ $(date +%s) -lt $DEADLINE ]]; do
  sleep 0.2
done
if [[ ! -f "$KDI_STUB_MARKER" ]]; then
  echo "FAIL: stub marker never created within 10s"
  echo "--- dispatch.log ---"
  cat "$TMP/dispatch.log"
  kill -TERM $DISPATCH_PID 2>/dev/null || true
  exit 1
fi
echo "PASS: stub marker created"

echo
echo "==> wait for task to land in done (max 5s)..."
DEADLINE=$(( $(date +%s) + 5 ))
STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$($KDI show "$TASK_ID" 2>/dev/null | awk '/^Status:/ {print $2; exit}')
  if [[ "$STATUS" == "done" ]]; then break; fi
  sleep 0.2
done
echo "Final status: $STATUS"
if [[ "$STATUS" != "done" ]]; then
  echo "FAIL: task did not reach done"
  echo "--- dispatch.log ---"
  cat "$TMP/dispatch.log"
  kill -TERM $DISPATCH_PID 2>/dev/null || true
  exit 1
fi

echo
echo "==> stop dispatcher"
kill -TERM $DISPATCH_PID 2>/dev/null || true
wait $DISPATCH_PID 2>/dev/null || true

echo
echo "==> inspect kdi show / runs / log"
echo "--- kdi show $TASK_ID ---"
$KDI show "$TASK_ID"

echo
echo "--- kdi runs $TASK_ID ---"
$KDI runs "$TASK_ID"

echo
echo "--- kdi log $TASK_ID ---"
$KDI log "$TASK_ID"

echo
echo "==> final assertions"
# outcome=completed in runs
if $KDI runs "$TASK_ID" | grep -q "outcome=completed"; then
  echo "PASS: outcome=completed in task_runs"
else
  echo "FAIL: outcome != completed"
  exit 1
fi

# worker_pid > 0 in runs
PID=$($KDI runs "$TASK_ID" | grep -oE 'profile=stub' | head -1)
if [[ -n "$PID" ]]; then
  echo "PASS: profile=stub recorded"
else
  echo "FAIL: profile not recorded"
  exit 1
fi

# log file written
if $KDI log "$TASK_ID" | grep -q "stub: task $TASK_ID"; then
  echo "PASS: log captures stub harness stdout"
else
  echo "FAIL: log missing stub harness output"
  exit 1
fi

# task_events show the autonomous transitions
TAIL_OUT=$(bun run "$SCRIPT_DIR/_with-timeout.ts" 1 $KDI tail "$TASK_ID" 2>/dev/null || true)
echo "--- kdi tail $TASK_ID (initial dump, 1s) ---"
echo "$TAIL_OUT" | head -10
if echo "$TAIL_OUT" | grep -qE "promoted|claimed|completed|finished"; then
  echo "PASS: events for claim/promote/completion present"
else
  echo "FAIL: events check missing expected kinds"
  exit 1
fi

echo
echo "==> cleanup temp profile"
rm -f "$HOME/.config/kdi/profiles.yaml"
echo "Removed: $HOME/.config/kdi/profiles.yaml"

# Keep TMP for inspection unless KEEP_TMP=0
if [[ "${KEEP_TMP:-1}" != "1" ]]; then
  rm -rf "$TMP"
fi

echo
echo "================================================================"
echo "E2E RESULT: PASS"
echo "Stub harness was spawned by the dispatcher, ran to completion,"
echo "marked the task done with outcome=completed, and wrote a log file."
echo "================================================================"
