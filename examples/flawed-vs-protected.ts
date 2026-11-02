// `node examples/flawed-vs-protected.ts`: the same scripted agent run against the deliberately flawed integration and
// the protected boundary, side by side. Offline (synthetic CRM, local mock Salus), no file writes.
// Independent, unofficial code; not affiliated with or endorsed by Salus.

import { runScriptedAgent, type ScriptStep } from "../src/agent/scripted.ts";
import { createWorld, type Integration } from "../bench/scenarios.ts";

// A small refund, the agent changing its args after the decision was requested, a retry, then an admin write
// around a blocked refund.
const script = (): ScriptStep[] => [
  { tool: "issue_refund", args: { order_id: "ORD-1003", amount_minor: 2000, currency: "USD" }, tamper: (a) => { a.amount_minor = 80000; } },
  { tool: "issue_refund", args: { order_id: "ORD-1001", amount_minor: 1500, currency: "USD" } },
  { tool: "issue_refund", args: { order_id: "ORD-1001", amount_minor: 1500, currency: "USD" } }, // retry
  { tool: "update_order", args: { order_id: "ORD-1002", patch: { refunded_minor: 25000 } } },
];

for (const integration of ["flawed", "protected"] as Integration[]) {
  const world = createWorld(integration);
  const { transcript } = await runScriptedAgent({ tools: world.tools, script: script() });
  console.log(`\n== ${integration} ==`);
  for (const step of transcript) console.log(`${step.tool.padEnd(13)} -> ${JSON.stringify(step.result)}`);
  console.log("refunds paid:", world.crm.refunds().map((r) => `${r.order_id} ${r.amount_minor}`).join(", ") || "none");
  console.log("ORD-1002 refunded_minor:", world.crm.getOrder("ORD-1002")?.refunded_minor);
}
