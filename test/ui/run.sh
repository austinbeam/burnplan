#!/usr/bin/env bash
# Runs the planner unit tests and every UI regression script.
# A UI script fails if it raises (Playwright timeout / assertion) or prints a non-empty "ERRORS [...]" line
# (uncaught page errors). Most scripts also print what they saw; read it when a behavior change is intended.
# Usage: test/ui/run.sh            all except the slow landing test
#        test/ui/run.sh --all      include landtest (~5 min)
#        test/ui/run.sh fueltest donetest   just these
set -u
cd "$(dirname "$0")"
node --test ../planner.test.mjs 2>&1 | grep -E '^# (pass|fail)'
if [ $# -gt 0 ] && [ "$1" != "--all" ]; then TESTS="$*"; else
  TESTS=$(ls *.py | grep -v common.py | sed 's/\.py$//' | sort)
  [ "${1:-}" = "--all" ] || TESTS=$(echo "$TESTS" | grep -v '^landtest$')
fi
fail=0
for t in $TESTS; do
  out=$(timeout 400 python3 "$t.py" 2>&1); code=$?
  errs=$(echo "$out" | grep -E '^ERRORS' | tail -1)
  if [ $code -ne 0 ] || echo "$out" | grep -q Traceback || ! echo "$errs" | grep -qE '^ERRORS:? \[\]$'; then
    echo "FAIL $t"; echo "$out" | tail -8 | sed 's/^/    /'; fail=1
  else echo "ok   $t"; fi
done
exit $fail
