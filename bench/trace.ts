// `node bench/trace.ts --seed 7`: replays run 1 of `node bench/run.ts --seed 7` for every scenario and integration,
// and prints what actually happened as JSON. It records the tool calls (with arguments as passed and, if they changed
// while the call was running, as they ended up), every /v1/decide request the local mock accepted, the audit log, the
// refunds paid and the order state. It runs the same scenario code as the benchmark, so it shows the same verdicts.
// Offline: local mock only, no network, no Salus key. Independent, unofficial code; not affiliated with Salus.

import { SCENARIO_IDS, SCENARIOS, createPrng, createWorld, type Integration } from "./scenarios.ts";
import type { ToolDefinition } from "../src/agent/scripted.ts";
import { requireMockMode } from "../src/mcp/mode.ts";

requireMockMode(); // same fail-closed guard as the benchmark and the server

const arg = process.argv.indexOf("--seed");
const seed = arg > 0 ? Number(process.argv[arg + 1]) : 7;
if (!Number.isSafeInteger(seed) || seed < 0) {
  process.stderr.write("usage: node bench/trace.ts [--seed N]\n");
  process.exit(2);
}

interface ToolCallRecord { process: string; tool: string; args_at_call: unknown; args_after?: unknown; result?: unknown; threw?: true }

const copy = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function record(tools: ToolDefinition[], process: string, calls: ToolCallRecord[]): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    async call(args: Record<string, unknown>) {
      const rec: ToolCallRecord = { process, tool: tool.name, args_at_call: copy(args) };
      calls.push(rec);
      try {
        const result = await tool.call(args);
        rec.result = copy(result);
        return result;
      } catch (error) {
        rec.threw = true;
        throw error;
      } finally {
        const after = copy(args);
        if (JSON.stringify(after) !== JSON.stringify(rec.args_at_call)) rec.args_after = after;
      }
    },
  }));
}

const traces: unknown[] = [];
for (const [index, id] of SCENARIO_IDS.entries()) {
  for (const integration of ["flawed", "protected"] as Integration[]) {
    // The same input stream as run 1 (r = 0) of bench/run.ts for this seed and scenario.
    const rng = createPrng((seed * 1_000_003 + index * 10_007 + 0) >>> 0);
    const world = createWorld(integration);
    const calls: ToolCallRecord[] = [];
    const faults: { kind: string; count: number }[] = [];
    world.tools = record(world.tools, "process 1", calls);
    const makeTools = world.makeTools;
    world.makeTools = () => record(makeTools(), "process 2 (restarted)", calls);
    const failNext = world.mock.failNext.bind(world.mock);
    world.mock.failNext = (kind, count = 1) => { faults.push({ kind, count }); return failNext(kind, count); };

    const held = await SCENARIOS[id].run(world, rng);
    traces.push({
      id, integration, invariant_held: held, faults_injected: faults, tool_calls: calls,
      decide_requests: world.mock.requests.map((r) => ({ tool_name: r.tool_name, idempotency_key: r.idempotency_key, args: r.args })),
      policy_evaluations: world.mock.evaluations,
      audit: integration === "protected" ? world.audit.entries() : null,
      refunds_paid: world.crm.refunds().map((r) => ({ refund_id: r.refund_id, order_id: r.order_id, amount_minor: r.amount_minor, idempotency_key: r.idempotency_key })),
      orders_after: ["ORD-1001", "ORD-1002", "ORD-1003"].map((orderId) => {
        const o = world.crm.getOrder(orderId);
        return { order_id: orderId, amount_minor: o?.amount_minor, refunded_minor: o?.refunded_minor };
      }),
    });
  }
}

process.stdout.write(JSON.stringify({
  source: `node bench/trace.ts --seed ${seed} (run 1 of bench/run.ts --seed ${seed})`,
  environment: { node: process.version, mock: true, note: "Offline. Local in-process mock of /v1/decide; no network, no Salus key." },
  traces,
}, null, 1) + "\n");
