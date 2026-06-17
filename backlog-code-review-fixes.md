# Code Review Fixes Backlog — Specs 036-039

- [ ] KDI-036: Fix CRITICAL SQL injection in getRuns (whitelist stateType), HIGH test exit code leak (reset process.exitCode), MEDIUM formatRun behavior change/unescaped fields, add CLI filter tests
- [ ] KDI-037: Fix CRITICAL lazy PID-marker writes in tick() for new boards, CRITICAL signal handlers not awaiting dispatcher.stop(), HIGH clearAllDispatcherPids using directory scan instead of tracked Set
- [ ] KDI-038: Fix CRITICAL context accumulation using verdict.result on continue, MEDIUM --goal-judge flag gating, fix temp dir leaks, fix {{task_id}} substitution, fix char-based cap
- [ ] KDI-039: Fix CRITICAL duplicate BRD files, CRITICAL test suite failures from missing imports in tests/task.test.ts, add model validation guard, template name cap, avoid any in event payloads
