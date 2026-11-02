// ============================================================================================================
// WARNING: DELIBERATELY UNSAFE. FOR DEMONSTRATION ONLY. DO NOT COPY THIS INTO REAL CODE.
//
// This integration wires a CRM to Salus's /v1/decide the WRONG way, on purpose, so the tests and the benchmark can
// show what goes wrong. The corrected version is src/integrations/protected.ts. Each flaw is marked "FLAW" below:
//
//   1. Alternate write path: `update_order` writes to the CRM (including `refunded_minor`) with no Salus decision,
//      so the policy on `issue_refund` can simply be bypassed ("no unprotected path to the same side effect").
//   2. Arguments changed after the decision: `issue_refund` asks Salus about the args, then executes from the same
//      mutable args object, so anything that changes it after the decision was requested wins.
//   3. Fail-open: when /v1/decide times out or errors, `issue_refund` executes anyway (the docs say fail closed).
//   4. Duplicate on retry: every call uses a fresh idempotency key, for Salus and for the CRM, so a retried or
//      repeated refund is paid twice.
//
// Independent, unofficial code; not affiliated with or endorsed by Salus.
// ============================================================================================================

import type { Crm, OrderPatch } from "../crm/crm.ts";
import type { DecideClient } from "../decide/client.ts";
import type { ToolDefinition } from "../agent/scripted.ts";

export function createFlawedTools(options: { crm: Crm; decide: DecideClient }): ToolDefinition[] {
  const { crm, decide } = options;
  // FLAW 4 (duplicate on retry): a per-call counter, not a key derived from the action. Deterministic, but a new
  // key every time, so neither Salus nor the CRM can recognise a retry of the same refund.
  let calls = 0;

  const lookupOrder: ToolDefinition = {
    name: "lookup_order",
    description: "Look up a synthetic order by ID.",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    async call(args) {
      const order = crm.getOrder(String(args.order_id));
      return order ? { status: "ok", order } : { status: "error", error: "not_found" };
    },
  };

  const issueRefund: ToolDefinition = {
    name: "issue_refund",
    description: "Refund part or all of an order (UNSAFE demonstration integration).",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount_minor: { type: "integer" }, currency: { type: "string" } },
      required: ["order_id", "amount_minor", "currency"],
    },
    async call(args) {
      calls += 1;
      const idempotencyKey = `flawed-${calls}`; // FLAW 4: fresh key per call
      const decision = await decide.decide({ tool_name: "issue_refund", idempotency_key: idempotencyKey, args, mode: "enforce" });
      // FLAW 3 (fail-open): a decide error (timeout, network, 5xx, malformed...) is treated as permission to proceed.
      if (decision.ok && decision.decision !== "allow") {
        return { status: "action_not_executed", decision: decision.decision, reason_code: decision.reason_code };
      }
      // FLAW 2 (args changed after the decision): execute from the live, mutable `args`, not the copy Salus saw.
      const result = crm.refund({
        order_id: args.order_id as string,
        amount_minor: args.amount_minor as number,
        currency: args.currency as string,
        idempotency_key: idempotencyKey,
      });
      if (!result.ok) return { status: "error", error: result.error };
      return { status: "executed", refund_id: result.refund_id, amount_minor: result.amount_minor, decided: decision.ok };
    },
  };

  const updateOrder: ToolDefinition = {
    name: "update_order",
    description: "Admin: patch fields on an order (UNSAFE demonstration integration).",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, patch: { type: "object" } },
      required: ["order_id", "patch"],
    },
    async call(args) {
      // FLAW 1 (alternate write path): no Salus decision at all, and it can set refunded_minor directly.
      const out = crm.updateOrder(String(args.order_id), args.patch as OrderPatch);
      return out.ok ? { status: "updated", order: out.order } : { status: "error", error: "not_found" };
    },
  };

  return [lookupOrder, issueRefund, updateOrder];
}
