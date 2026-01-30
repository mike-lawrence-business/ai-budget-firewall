# QA Report — Durable Budgeting (AIBudgetFirewall)

Status: In-progress — tests run locally; PR updated with smoke scripts and tests. See final section for next steps and remediation.

## Summary
Performed local automated and manual QA focused on durable-budgeting, pricing/accounting, /usage endpoint, streaming and non-streaming flows, audit logging, and deployment configuration. Added smoke tests and concurrency tests to the feature/durable-budgeting branch.

## What I ran
- npm test (cost unit tests) — PASS
- local test harness (test/local_test.js) — PASS for cost and blocking/allowing logic when mocked upstream
- DO sequential increment test (test/test_do_serial.mjs) — PASS (simulates CF Durable Object single-instance serialization)
- DO concurrent increment test (test/test_do_concurrent.mjs) — shows race in local in-memory simulation (expected to fail locally because Node executes fetch handlers concurrently)
- Added scripts/qa-smoke.sh to orchestrate the above

## Pass/Fail Checklist
- [x] Unit tests (costs) — PASS
- [x] /usage endpoint presence — Present in src/index.js; local behavior validated in local_test
- [x] Pricing table fallback — Default table present in code — PASS
- [x] Token -> USD calculation — validate via unit tests — PASS
- [x] Non-streaming flows accounting & DO increment — Verified via local_test (mocked upstream + waitUntil) — PASS
- [x] Streaming flows processing logic — Code includes stream.tee and extractor; not fully exercised by tests — PARTIAL
- [x] Audit logging (no sensitive text) — recordAudit writes only metadata keys in KV — PASS (static code inspection)
- [x] Durable Object atomicity — Sequential simulation PASS; true concurrent simulation requires deployed DO — PARTIAL
- [x] Storage TTL / daily key scheme — Uses date-scoped keys usage:YYYY-MM-DD — PASS (no TTL)
- [x] CI job & smoke script — smoke script added; CI job not yet added — PARTIAL
- [x] wrangler.toml documents DAILY_BUDGET — UPDATED
- [x] Security: retry/dedup/idempotency — Not fully tested; potential double-counting on retries in some edge cases — PARTIAL

## Findings / Prioritized Bug / Issue List
1. (P0) Race condition observed in local parallel calls to BudgetCounter.fetch (test/test_do_concurrent.mjs). Root cause: local test harness calls fetch concurrently; in Cloudflare production Durable Objects, requests to the same DO instance are handled sequentially, which avoids this race. However, if multiple DO instances exist for the same budgetId (misconfigured idFromName usage or different names), or if code is changed in future to run operations across instances, double-counting or races could occur. Recommendation: document assumption and add defensive code (e.g., state.storage.transaction-like pattern or using a single DO-per-budget invariant). Also add tests in CI that run against a deployed preview worker to confirm production behavior.

2. (P1) Streaming accounting not fully tested. The current stream extraction attempts to parse a JSON object at the end of the buffered stream; this heuristic may fail for some streaming formats (SSE, chunks with trailing logs). Recommendation: add unit tests for extractFinalJson with common streaming payloads (OpenAI chunked responses), and add robustness: parse event-stream lines for data: JSON chunks and accumulate last object. Also validate that charges are recorded only once after stream completes.

3. (P1) recordAudit currently stores JSON with fields {budgetId, model, tokens, cost, timestamp} — good. But in index.js recordAudit() call for non-streaming uses tokens object {prompt, completion} and for stream uses same. Ensure values are numbers, and do not accidentally include prompt/completion text. Add a sanitization check in recordAudit to ensure only numbers are saved.

4. (P2) No TTL on daily usage keys. Storage grows daily; consider adding a retention policy or background job to delete old keys. Cloudflare DO storage doesn't support TTL on storage.put directly; recommend storing date-scoped keys and a housekeeping script to prune older than X days, or use KV with TTL. Document retention expectations.

5. (P2) /usage endpoint: currently reads env.DAILY_BUDGET and KV limit:<budgetId> and header override; behavior is OK. Edge case: if env.DAILY_BUDGET missing or zero, endpoint returns remaining as 0 or negative; document behavior and default fallback.

6. (P2) Lack of CI workflow. Add lightweight GitHub Actions to run npm test and smoke script (sequential parts) and, if possible, run smoke script against preview worker (requires Wrangler and secrets). For now add a job that runs unit tests and smoke script's sequential checks.

7. (P3) Idempotency / retry handling: If upstream call is retried at proxy level (before accounting recorded), double-counting may occur. To mitigate, implement dedup using request-id header and track processed request-ids in KV (or DO) with short TTL. This requires upstream clients to send idempotency keys (or generate hash of request). Recommend adding optional X-Request-ID handling.

## Remediation Plan (short-term)
- Add tests and smoke script (done). Commit pushed and branch updated: feature/durable-budgeting (PR #1 exists).
- Add defensive sanitization in recordAudit to ensure numeric tokens only. (I'll prepare a small patch.)
- Add unit tests for extractFinalJson and streaming parsing; create improvements to parsing logic. (I'll add tests and a small helper to robustly parse SSE/data: lines.)
- Add a lightweight GitHub Actions workflow to run npm test and the sequential smoke steps. (I'll create .github/workflows/qa.yml in the PR.)
- Document assumptions re: DO serialization in README and wrangler.toml (add note). (I'll add a README section.)

## Remediation Plan (medium-term)
- Add idempotency dedup logic (optional header X-Request-ID) to avoid double-counts on retries.
- Add retention/TTL policy for audit and usage keys.
- Add an integration test job that deploys to a preview worker and runs the concurrent-load smoke test to validate atomicity in production.

## Commits / PRs created
- feature/durable-budgeting branch updated with: 
  - scripts/qa-smoke.sh
  - test/test_do_concurrent.mjs
  - test/test_do_serial.mjs
  - updated wrangler.toml

A PR for this branch already exists: https://github.com/mike-lawrence-business/ai-budget-firewall/pull/1 (branch feature/durable-budgeting)

## Next actions I plan to take (I will proceed after your confirmation):
1. Add sanitization for audit writes and a unit test. (low risk) — will commit to feature/durable-budgeting.
2. Improve streaming extraction and add tests for extractFinalJson to cover common OpenAI streaming formats. (medium)
3. Add GitHub Actions workflow for CI (low risk).
4. Add optional idempotency checks (ask: do we want to require clients to send X-Request-ID?).

If you approve, I'll start with (1) and (2) and open follow-up PRs/commits to the same branch.

