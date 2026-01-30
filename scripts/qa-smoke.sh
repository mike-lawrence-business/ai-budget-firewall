#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Running QA smoke script for ai-budget-firewall"
echo "1) npm test"
npm test

echo "2) Run local test harness"
node test/local_test.js

echo "3) Run sequential DO increment test (simulates CF DO serialization)"
node test/test_do_serial.mjs

echo "4) Run parallel DO increment test (shows race in local env — expected to fail locally)"
node test/test_do_concurrent.mjs || true

echo "Smoke script complete"
