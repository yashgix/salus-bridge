# Salus Bridge

**Independent, unofficial project. Not affiliated with or endorsed by Salus.**

A small TypeScript reference example (not an SDK) for Salus's documented `/v1/decide` API. It shows, with tests and a
seeded benchmark, why an AI agent's tool calls need **one trusted execution boundary**, and what goes wrong when side
effects can get around it. It runs fully offline: a synthetic CRM refund workflow and a local mock of `/v1/decide`.
No network, no Salus account and no API key are needed.

- **Write-up:** [docs/WRITEUP.md](docs/WRITEUP.md), covering the design, the failure scenarios and the trade-offs.
- **Contract:** [docs/decide-contract.md](docs/decide-contract.md), covering what Salus documents and what it leaves
  out.
- **Visual summary:** [artifact/index.html](artifact/index.html), a one-page overview you can open in a browser.

## The problem

Salus decides whether a proposed agent action should run: `allow`, `block` or `escalate`. The decision only protects
anything if the code that performs the side effect enforces it, every time, for exactly the action that was decided.
Salus's own guidance puts it this way: "If some tool calls hit Salus and others do not, you no longer have a
trustworthy control plane." This repo makes that concrete:

- a **deliberately flawed integration** that asks Salus and still lets money move:
  - through an alternate write path;
  - with arguments changed after the decision;
  - when the decision fails;
  - twice on a retry;
- a **corrected boundary** that closes each of those paths. Tests and the benchmark show the difference.

## Architecture

```
scripted agent ──tool call──▶ integration (flawed │ protected) ──execute──▶ synthetic CRM (refund + idempotency)
                                   │                    │
                                   │                    └──append──▶ audit log (decided → executed / not_executed)
                                   ▼
                          /v1/decide client ──injected fetch──▶ local mock of /v1/decide
```

| Path | What it is |
|---|---|
| `src/decide/client.ts` | The `/v1/decide` client. It sends only documented fields and accepts only `allow`, `block` or `escalate`. It has a bounded timeout and retries, and it never throws. |
| `src/decide/mock.ts` | A local, in-process mock of `/v1/decide`, reached through an injected `fetch` (no sockets), with fault injection. |
| `src/crm/crm.ts` | A synthetic in-memory CRM with made-up orders and provider-side refund idempotency. |
| `src/agent/scripted.ts` | A **scripted, deterministic agent**: a fixed list of tool calls. No LLM, no randomness. |
| `src/integrations/flawed.ts` | A **deliberately unsafe** integration, for demonstration only. |
| `src/integrations/protected.ts` | The corrected boundary, with the append-only audit log in `src/integrations/audit.ts`. |
| `src/mcp/server.ts` | An **MCP-style** stdio server that exposes only the protected boundary. |
| `bench/` | A seeded benchmark that runs every scenario against both integrations. |
| `examples/` | Small runnable examples. |
| `test/acceptance/` | Acceptance tests for each component, and the type check. |

## Setup

You need **Node 24 or later**. Node runs the `.ts` files directly; there is no build step.

```sh
npm ci                                              # installs only the pinned TypeScript compiler (type checking)
node --test                                         # all tests (39)
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

## Demo

```sh
node examples/flawed-vs-protected.ts
```

The same scripted agent runs against both integrations. It makes a small refund but changes the amount after
asking, retries a refund, and then tries an admin write around the check. An excerpt of the output:

```
== flawed ==
refunds paid: ORD-1003 80000, ORD-1001 1500, ORD-1001 1500     # tampered amount paid; the retry paid twice
ORD-1002 refunded_minor: 25000                                 # changed with no decision at all
== protected ==
refunds paid: ORD-1003 2000, ORD-1001 1500                     # the decided amount; the retry was replayed
update_order  -> {"status":"error","error":"unknown_tool"}     # no alternate write path
```

Other entry points:

```sh
node bench/run.ts --seed 7 --runs 30                # benchmark: prints one JSON object
node src/mcp/server.ts                              # MCP-style server on stdin/stdout
node examples/mcp-in-process.ts                     # the server's JSON-RPC handler, driven in-process
```

## Benchmark summary

`node bench/run.ts --seed N --runs M` runs 10 scenarios, each `M` times, against the flawed and the protected
integrations. Each run uses a fresh world and inputs drawn from a seeded PRNG, and each scenario checks one invariant.
`invariant_held` is true only if the invariant held in every run; `runs_violated` counts the runs where it did not.
The results below are from `--seed 7 --runs 30` (saved in
[docs/results/bench-seed7-runs30.json](docs/results/bench-seed7-runs30.json)):

| Scenario | Invariant | Flawed | Protected |
|---|---|---|---|
| `allow_small_refund` | An allowed refund is paid exactly once, for the requested amount | held | held |
| `escalate_medium_refund` | `escalate` never pays (pending a human) | held | held |
| `block_large_refund` | `block` never pays | held | held |
| `bypass_alternate_write` | No path other than a decided refund changes an order's refund state | **violated** (30/30) | held |
| `args_tampered_after_decision` | What is paid is exactly what was decided | **violated** (30/30) | held |
| `fail_open_on_timeout` | No decision (timeout) means no payment | **violated** (30/30) | held |
| `malformed_response` | A malformed success response is not an allow | **violated** (30/30) | held |
| `duplicate_retry` | A retried refund pays once | **violated** (30/30) | held |
| `concurrent_duplicate` | Two simultaneous identical refunds pay once | **violated** (30/30) | held |
| `crash_recovery` | An unknown outcome is visible after a restart, and the retry pays once in total | **violated** (30/30) | held |

The protected integration held **10 of 10** invariants; the flawed one held 3 and violated 7. For the same seed the
correctness output (`scenarios` and `summary`) is identical: it uses no clock and no `Math.random`.

**Latency is measured against the local in-process mock only.** On an Apple M4 Pro with Node 24.22.2, this run gave
decide p50 0.030 ms and p95 0.078 ms, and the full protected `issue_refund` p50 0.037 ms and p95 0.107 ms. Timing
varies from run to run, and scenarios with injected faults are left out. **These numbers say nothing about real Salus
latency.** They only show that the boundary code itself adds very little.

## The MCP-style server

`node src/mcp/server.ts` reads newline-delimited JSON-RPC 2.0 from stdin and writes one response per line to stdout.
It is "MCP-style": it uses the `initialize`, `tools/list` and `tools/call` method names and result shapes. **We do
not claim it is MCP-compatible.**

- `initialize` returns `serverInfo.name: "salus-bridge"` and `capabilities.tools`.
- `tools/list` returns exactly `issue_refund` and `lookup_order`. There is no `update_order`, so there is no
  unprotected path to the refund.
- `tools/call` returns `content[0].text`, which holds the tool result as JSON. An unknown tool gives `isError: true`.
- An unknown method returns `-32601`. A line that cannot be parsed returns `-32700` with `id: null`.
- The server exits with code 0 when stdin closes.

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"issue_refund","arguments":{"order_id":"ORD-1001","amount_minor":1000,"currency":"USD"}}}' | node src/mcp/server.ts
```

**Offline only (`SALUS_BRIDGE_MODE`).** v1 makes no real Salus calls. The server and the benchmark always use the
synthetic CRM, the local mock and an in-memory audit log, and they never read a Salus key. `SALUS_BRIDGE_MODE` may be
unset or set to `mock`. Any other value **fails closed**: the process prints a message to stderr and exits non-zero
before it creates any client.

## Documented behaviour versus our mock's assumptions

[docs/decide-contract.md](docs/decide-contract.md) is the only source of truth for Salus behaviour in this repo. It
is based on the public docs at [docs.usesalus.ai](https://docs.usesalus.ai/docs/cloud-custom), read on 2 Nov 2026.

- **Documented by Salus:**
  - `POST {base}/decide` with Bearer auth;
  - the request fields (`tool_name`, `idempotency_key` (required), `args`, `mode`, …);
  - the decisions `allow`, `block` and `escalate`;
  - the error statuses with a `{ "detail": … }` body, including 409 for the same idempotency key with different
    arguments;
  - "fail closed on Salus timeout/error";
  - one enforcement boundary, with "no unprotected path to the same side effect";
  - provider idempotency as well as a stable Salus key.
- **Our mock's assumptions** (labelled `MOCK ASSUMPTION` in `src/decide/mock.ts`; not Salus behaviour):
  - the refund thresholds (allow up to 10000 minor units, escalate up to 50000, block above that);
  - replaying the first decision for the same key and the same arguments;
  - 400 versus 422 for missing or mistyped fields;
  - the fault injection;
  - the `mock_*` reason codes.
- **Our own policy, not Salus's:**
  - the client's timeout and bounded retries;
  - treating `escalate` as "not executed, pending a human";
  - correlating the audit log by `idempotency_key`, because the HTTP decision ID field is not documented.

The protected boundary enforces decisions **client-side**, in this process. It is not Salus's own enforcement. The
docs describe raw `decide_only` verdicts as advisory, and say "Python is supported today. TypeScript support is coming
soon."

## Status and limits

This is a reference example, **not production code and not an SDK**. It runs only against the local mock: it has not
been run against the real Salus service. It uses no real LLM (the agent is scripted), and its MCP-style server makes
no claim of MCP compatibility. A production integration would need, at least:

- a real Salus runtime key, kept in a secret manager;
- the boundary as the only holder of the provider credential;
- caller-supplied request IDs for idempotency;
- an approval workflow for `escalate`;
- outcome reporting;
- a durable audit store.

See [docs/WRITEUP.md](docs/WRITEUP.md#7-trade-offs-and-limits) for the full list.

## How this was built

I built this with supervised AI coding agents:
- I set the scope and the requirements, and approved every plan and merge.
- A contract from Salus's public docs and the acceptance tests were written first.
- Claude Code agents implemented each component in sandboxed, serial tasks.
- OpenAI Codex reviewed each change independently.
- The tests and benchmark were then re-run independently before release.

## License

[MIT](LICENSE) © 2026 Yash Gupta
