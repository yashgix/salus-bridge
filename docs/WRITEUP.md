# Salus Bridge: a trusted execution boundary for agent tool calls

**Independent, unofficial project. Not affiliated with or endorsed by Salus.** Everything here runs offline against a
local mock. Nothing was measured against the real Salus service.

## 1. The problem
An agent that can call `issue_refund` can move money. Salus's `/v1/decide` answers one question before a tool runs:
should this exact action happen? The answer is `allow`, `block` or `escalate`.

Asking is only half the job. Salus's own integration guidance stresses three things:
- there must be "no unprotected path to the same side effect";
- the client must "fail closed on Salus timeout/error";
- the client must use a stable idempotency key, together with the provider's own idempotency.

A raw `/v1/decide` call is advisory: the docs say `decide_only` verdicts "cannot be promoted to enforcement".
Whatever executes the tool has to enforce the answer. This project shows, with tests, what goes wrong when that
code is careless and what a correct boundary looks like.

What the docs say, and the 8 places where they are silent, is in [decide-contract.md](decide-contract.md). Where
the docs are silent, the code fails closed or labels the behaviour as an assumption of our mock.

## 2. Architecture
```
scripted agent ──tool call──▶ integration (flawed | protected) ──▶ synthetic CRM (refunds, idempotency)
                                     │
                                     └──▶ /v1/decide client ──injected fetch──▶ local mock of /v1/decide
```
- **`src/decide/client.ts`:** a small `/v1/decide` client.
  - It snapshots the request when called and sends exactly the documented fields.
  - It accepts only `allow`, `block` or `escalate`; anything else is `malformed`.
  - It enforces a timeout even if `fetch` ignores the abort.
  - It retries only on 429, 503, timeouts and network errors, with the same body and key each time and a bounded
    number of attempts.
  - It never throws, and it redacts the API key from results.
- **`src/decide/mock.ts`:** an in-process mock with fault injection (timeout, network, 503, 429, malformed). Its
  refund thresholds and same-key replay are labelled `MOCK ASSUMPTION`.
- **`src/crm/crm.ts`:** synthetic orders and provider-side refund idempotency, keyed by `idempotency_key`.
- **`src/agent/scripted.ts`:** a deterministic "agent" that runs a fixed list of tool calls. A `tamper` hook lets a
  script change its arguments after a call has started, which simulates a compromised or confused agent.
- **`src/mcp/server.ts`:** an MCP-style JSON-RPC stdio server that exposes only the protected tools. It uses MCP
  method names and result shapes, but no compatibility with MCP clients is claimed or tested.

## 3. The deliberately flawed integration (`src/integrations/flawed.ts`)
It looks reasonable and has four flaws:
1. **Alternate write path:** an `update_order` tool writes `refunded_minor` with no decision at all.
2. **Arguments changed after the decision:** it asks Salus about `args`, then executes from the same mutable
   object. An argument changed during the `await` is paid.
3. **Fail-open:** on a timeout or error it executes anyway.
4. **No stable idempotency:** each call gets a fresh key, so a retry or two concurrent identical calls pay twice.

## 4. The corrected boundary (`src/integrations/protected.ts`)
- **One path to the side effect.**
  - Only `lookup_order` (read-only) and `issue_refund` exist.
  - `crm.refund` is called in exactly one place, after an explicit `allow`.
- **Exact-action binding.**
  - The arguments are validated (exactly `order_id`, `amount_minor` and `currency`, using `Reflect.ownKeys`, so
    hidden extra keys are caught).
  - They are copied and frozen when the call starts.
  - The frozen copy is what Salus decides on, what is hashed into the audit log, and what the CRM receives.
- **Fail closed.** Anything other than `ok: true, decision: "allow"` means no refund:
  - timeouts, network errors, 401, 409, 429 and 503;
  - malformed or unknown decisions;
  - a client that throws;
  - an audit log that cannot record the decision.
- **`escalate` means "not executed, pending a human".** The docs say approval "grants a one-time retry for the same
  payload". The caller retries the same action, and it must be decided `allow` again.

## 5. Idempotency, concurrency, audit and recovery
- **Key:** `refund:{order_id}:{amount_minor}:{currency}`, derived from the action alone. The same key goes to Salus
  and to the CRM.
- **Concurrency:** identical calls in the same process share one in-flight execution. A later retry asks Salus
  again ("every retry is a new proposal") and relies on the CRM's idempotency to pay once.
- **Audit log** (`src/integrations/audit.ts`):
  - It is append-only JSON lines. A `decided` entry is written before any effect. Then one of:
    - `executed` (the CRM confirmed the refund);
    - `not_executed` with a reason, only when it is certain nothing was paid (block, escalate, a decide error, a
      provider refusal);
    - `outcome_unknown` when the provider threw, so the refund may or may not have been applied.
  - A torn last line is detected and marked on restart, never silently dropped.
- **Recovery (simulated):** if the CRM throws after an allow, the outcome is unknown.
  - The result is `execution_failed`, the audit records `outcome_unknown`, and the key stays in `pendingActions()`.
  - A restarted process reading the same file sees it. Retrying the same call pays once in total, because the CRM
    replays on the same key.
  - This is simulated in one process, with an in-memory CRM. Production recovery would also need durable storage and
    reconciliation with the real provider.

## 6. Results
`node bench/run.ts --seed 7 --runs 30` runs 10 scenarios 30 times each against both integrations. Each run uses a
fresh world and seeded random inputs. A scenario "held" only if its invariant held in all 30 runs. Measured on
2 Nov 2026 (Apple M4 Pro, Node 24.22.2). Raw output: [results/bench-seed7-runs30.json](results/bench-seed7-runs30.json).

| Scenario | Flawed | Protected |
|---|---|---|
| allow_small_refund | held | held |
| escalate_medium_refund | held | held |
| block_large_refund | held | held |
| bypass_alternate_write | violated (30/30 runs) | held |
| args_tampered_after_decision | violated (30/30) | held |
| fail_open_on_timeout | violated (30/30) | held |
| malformed_response | violated (30/30) | held |
| duplicate_retry | violated (30/30) | held |
| concurrent_duplicate | violated (30/30) | held |
| crash_recovery | violated (30/30) | held |

- **Summary:** protected 10 held, 0 violated; flawed 3 held, 7 violated.
- The correctness output is identical for a given seed.
- **Boundary overhead against the in-process mock:** decide p50 0.024 ms, p95 0.085 ms; full protected
  `issue_refund` p50 0.029 ms, p95 0.119 ms. Timing varies from run to run. These numbers are the cost of the
  boundary code on one laptop and **say nothing about real Salus latency.**

There are 39 tests:
- 32 acceptance tests across the client and mock, CRM and flawed integration, boundary, server and benchmark;
- 4 `Retry-After` tests;
- 1 determinism test;
- 2 type-check tests, which first verify the pinned compiler's files.

## 7. Trade-offs and limits
- **Client-side enforcement.** The boundary holds only if the agent cannot reach the CRM any other way. In production
  the boundary should be the only holder of the provider credential, or Salus's own SDK wrapper or proxy should be
  used.
- **One refund per amount.** Deriving the key from the action makes retries safe, but it also means two genuinely
  separate refunds with the same order, amount and currency are treated as one. A real system would key on a
  caller-supplied request ID.
- **Single process.** In-flight sharing is per process. Across processes, duplicate protection comes from the
  provider's idempotency.
- **The audit log is local**, append-only by API but not tamper-evident, and it assumes one writer. Outcomes are not
  reported to Salus, because the HTTP field for the decision ID is not documented.
- **No approval workflow.** The escalation follow-up over HTTP is undocumented, so nothing is invented.
- **Our own retry policy.** A `Retry-After` longer than 60 s returns the 429 instead of waiting.
- **Not in scope:** a real LLM, a real Salus account or key, network calls, MCP-client compatibility, and
  production hardening. **This is a reference example, not production code or an SDK.**
