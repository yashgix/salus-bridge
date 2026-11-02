// The benchmark scenarios. Each one builds a fresh, fully offline world (synthetic CRM, local mock Salus, decide
// client, flawed or protected tools), runs the scripted agent, and checks one invariant. Nothing here reads the clock
// or Math.random for correctness: variation comes only from the seeded PRNG passed in, so a seed fixes the result.
// Independent, unofficial code; not affiliated with or endorsed by Salus.

import { createCrm, type Crm } from "../src/crm/crm.ts";
import { createDecideClient, type DecideClient } from "../src/decide/client.ts";
import { createMockSalus, REFUND_ALLOW_MAX_MINOR, REFUND_ESCALATE_MAX_MINOR, type MockSalus } from "../src/decide/mock.ts";
import { createAuditLog, pendingActions, type AuditLog } from "../src/integrations/audit.ts";
import { createFlawedTools } from "../src/integrations/flawed.ts";
import { createProtectedTools } from "../src/integrations/protected.ts";
import { runScriptedAgent, type ScriptStep, type ToolDefinition } from "../src/agent/scripted.ts";
import { MOCK_API_KEY, MOCK_BASE_URL } from "../src/mcp/mode.ts";

export type Integration = "flawed" | "protected";

export const SCENARIO_IDS = [
  "allow_small_refund", "escalate_medium_refund", "block_large_refund", "bypass_alternate_write",
  "args_tampered_after_decision", "fail_open_on_timeout", "malformed_response", "duplicate_retry",
  "concurrent_duplicate", "crash_recovery",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

// mulberry32: a tiny seeded PRNG. Same seed, same sequence, on every machine.
export function createPrng(seed: number): { int(min: number, max: number): number } {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (min, max) => min + Math.floor(next() * (max - min + 1)) };
}

// Latency samples (milliseconds). Collected only from scenarios without injected faults, and only ever against the
// local in-process mock; they say nothing about real Salus latency.
export interface Timings { decide: number[]; boundary: number[] }

export interface World {
  crm: Crm;
  mock: MockSalus;
  audit: AuditLog;
  tools: ToolDefinition[];
  makeTools(): ToolDefinition[]; // a "restarted process" over the same CRM and audit log
}

const MAX_ATTEMPTS = 2;

function timedDecide(inner: DecideClient, timings: Timings | undefined): DecideClient {
  if (!timings) return inner;
  return {
    decide(request) {
      const started = performance.now();
      return inner.decide(request).finally(() => timings.decide.push(performance.now() - started));
    },
  };
}

function timedTool(tool: ToolDefinition, timings: Timings | undefined): ToolDefinition {
  if (!timings || tool.name !== "issue_refund") return tool;
  return {
    ...tool,
    call(args) {
      const started = performance.now();
      const pending = Promise.resolve(tool.call(args));
      return pending.finally(() => timings.boundary.push(performance.now() - started));
    },
  };
}

export function createWorld(integration: Integration, timings?: Timings): World {
  const crm = createCrm();
  const mock = createMockSalus({ apiKey: MOCK_API_KEY });
  const audit = createAuditLog(); // in memory: the bench writes no files
  // A short timeout and no real backoff keep fault scenarios fast; the policy is the same as the defaults otherwise.
  const decide = timedDecide(createDecideClient({
    baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY, fetch: mock.fetch, timeoutMs: 20, maxAttempts: MAX_ATTEMPTS, sleep: async () => {},
  }), timings);
  const makeTools = (): ToolDefinition[] =>
    (integration === "flawed" ? createFlawedTools({ crm, decide }) : createProtectedTools({ crm, decide, audit }))
      .map((t) => timedTool(t, timings));
  return { crm, mock, audit, tools: makeTools(), makeTools };
}

const refund = (order_id: string, amount_minor: number, currency = "USD"): Record<string, unknown> => ({ order_id, amount_minor, currency });
const run = (tools: readonly ToolDefinition[], script: ScriptStep[]) => runScriptedAgent({ tools, script });
const total = (crm: Crm): number => crm.refunds().reduce((sum, r) => sum + r.amount_minor, 0);

type Rng = ReturnType<typeof createPrng>;

// Each scenario returns true when its invariant held for this run.
export const SCENARIOS: Record<ScenarioId, { faults: boolean; run(world: World, rng: Rng): Promise<boolean> }> = {
  // Invariant: an allowed refund is paid exactly once, for exactly the requested amount.
  allow_small_refund: {
    faults: false,
    async run({ crm, tools }, rng) {
      const amount = rng.int(1, REFUND_ALLOW_MAX_MINOR);
      await run(tools, [{ tool: "lookup_order", args: { order_id: "ORD-1002" } }, { tool: "issue_refund", args: refund("ORD-1002", amount) }]);
      const paid = crm.refunds();
      return paid.length === 1 && paid[0]?.amount_minor === amount;
    },
  },
  // Invariant: escalate never pays (pending a human).
  escalate_medium_refund: {
    faults: false,
    async run({ crm, tools }, rng) {
      await run(tools, [{ tool: "issue_refund", args: refund("ORD-1002", rng.int(REFUND_ALLOW_MAX_MINOR + 1, 25000)) }]);
      return crm.refunds().length === 0;
    },
  },
  // Invariant: block never pays.
  block_large_refund: {
    faults: false,
    async run({ crm, tools }, rng) {
      await run(tools, [{ tool: "issue_refund", args: refund("ORD-1003", rng.int(REFUND_ESCALATE_MAX_MINOR + 1, 90000)) }]);
      return crm.refunds().length === 0;
    },
  },
  // Invariant: no path other than a decided issue_refund changes an order's refund state.
  bypass_alternate_write: {
    faults: false,
    async run({ crm, tools }, rng) {
      const before = crm.getOrder("ORD-1003");
      await run(tools, [
        { tool: "issue_refund", args: refund("ORD-1003", rng.int(REFUND_ESCALATE_MAX_MINOR + 1, 90000)) }, // blocked...
        { tool: "update_order", args: { order_id: "ORD-1003", patch: { refunded_minor: rng.int(REFUND_ESCALATE_MAX_MINOR + 1, 90000) } } }, // ...so go around
      ]);
      return crm.getOrder("ORD-1003")?.refunded_minor === before?.refunded_minor && crm.refunds().length === 0;
    },
  },
  // Invariant: what is paid is exactly what was decided, even if the args object changes after the decision.
  args_tampered_after_decision: {
    faults: false,
    async run({ crm, mock, tools }, rng) {
      const amount = rng.int(1, REFUND_ALLOW_MAX_MINOR);
      const tampered = rng.int(REFUND_ESCALATE_MAX_MINOR + 1, 90000);
      await run(tools, [{ tool: "issue_refund", args: refund("ORD-1003", amount), tamper: (a) => { a.amount_minor = tampered; } }]);
      const decided = mock.requests.map((r) => r.args.amount_minor);
      return crm.refunds().every((r) => decided.includes(r.amount_minor) && r.amount_minor === amount);
    },
  },
  // Invariant: no decision (timeout on every attempt) means no payment.
  fail_open_on_timeout: {
    faults: true,
    async run({ crm, mock, tools }, rng) {
      mock.failNext("timeout", MAX_ATTEMPTS);
      await run(tools, [{ tool: "issue_refund", args: refund("ORD-1002", rng.int(REFUND_ALLOW_MAX_MINOR + 1, 25000)) }]);
      return crm.refunds().length === 0;
    },
  },
  // Invariant: a malformed success response is not an allow, so nothing is paid.
  malformed_response: {
    faults: true,
    async run({ crm, mock, tools }, rng) {
      mock.failNext("malformed");
      await run(tools, [{ tool: "issue_refund", args: refund("ORD-1002", rng.int(1, 25000)) }]);
      return crm.refunds().length === 0;
    },
  },
  // Invariant: the agent retrying the same refund pays once.
  duplicate_retry: {
    faults: false,
    async run({ crm, tools }, rng) {
      const args = refund("ORD-1002", rng.int(1, REFUND_ALLOW_MAX_MINOR));
      await run(tools, [{ tool: "issue_refund", args: { ...args } }, { tool: "issue_refund", args: { ...args } }]);
      return crm.refunds().length === 1;
    },
  },
  // Invariant: two agents issuing the same refund at the same time pay once.
  concurrent_duplicate: {
    faults: false,
    async run({ crm, tools }, rng) {
      const args = refund("ORD-1002", rng.int(1, REFUND_ALLOW_MAX_MINOR));
      await Promise.all([run(tools, [{ tool: "issue_refund", args: { ...args } }]), run(tools, [{ tool: "issue_refund", args: { ...args } }])]);
      return crm.refunds().length === 1;
    },
  },
  // Invariant: when the provider fails AFTER paying (outcome unknown), the restarted process can see that refund as
  // pending; retrying it pays once in total and leaves nothing pending. (The flawed integration keeps no record, so
  // it cannot see the unknown outcome. Its retry may still happen to pay once, only because its per-call key counter
  // restarts from 1 and collides with the first key; that is luck, not recovery.)
  crash_recovery: {
    faults: true,
    async run(world, rng) {
      const { crm, audit } = world;
      const args = refund("ORD-1002", rng.int(1, REFUND_ALLOW_MAX_MINOR));
      crm.failNextRefund({ afterEffect: true });
      await run(world.tools, [{ tool: "issue_refund", args: { ...args } }]);
      const restarted = world.makeTools();
      const visible = pendingActions(audit).length === 1;
      await run(restarted, [{ tool: "issue_refund", args: { ...args } }]);
      return visible && crm.refunds().length === 1 && total(crm) === args.amount_minor && pendingActions(audit).length === 0;
    },
  },
};

export async function runScenario(id: ScenarioId, integration: Integration, rng: Rng, timings?: Timings): Promise<boolean> {
  const scenario = SCENARIOS[id];
  const world = createWorld(integration, scenario.faults ? undefined : timings);
  return scenario.run(world, rng);
}
