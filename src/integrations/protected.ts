// The corrected execution boundary: the CRM refund behind Salus's /v1/decide, done the right way. Compare with the
// deliberately unsafe src/integrations/flawed.ts. Contract: docs/decide-contract.md.
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// IMPORTANT: this boundary enforces decisions CLIENT-SIDE, in this process. It is NOT Salus's own enforcement. The
// docs say hard enforcement is the official SDK wrapper or Salus's proxy, and TypeScript SDK support is "coming
// soon"; here we call /v1/decide over HTTP and enforce the answer ourselves. It is only as strong as the guarantee
// that nothing else in the process can reach the CRM's write paths.
//
// How each flaw in flawed.ts is fixed:
//   1. One enforcement boundary, "no unprotected path to the same side effect": only lookup_order (read-only) and
//      issue_refund exist. There is no update_order, and crm.updateOrder is never called from here.
//   2. Arguments are validated, copied and frozen synchronously when the call starts. That frozen copy is what is
//      hashed into the audit log, sent to Salus, and executed; changing the caller's object afterwards does nothing.
//   3. Fail closed: only `{ ok: true, decision: "allow" }` executes. block, escalate, every decide error kind, a
//      malformed or unknown result, and a decide client that throws all mean no CRM call.
//   4. A stable idempotency key derived from the action alone, sent both to Salus and to the CRM (provider
//      idempotency), and concurrent identical calls share one in-flight execution, so a retry pays once.

import { createHash } from "node:crypto";
import type { Crm } from "../crm/crm.ts";
import type { DecideClient, DecideResult } from "../decide/client.ts";
import type { ToolDefinition } from "../agent/scripted.ts";
import type { AuditLog } from "./audit.ts";

const TOOL_NAME = "issue_refund";

interface RefundArgs {
  readonly order_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}

export type ProtectedRefundResult =
  | { status: "rejected"; reason: "invalid_arguments" }
  | { status: "executed"; refund_id: string; replayed: boolean; idempotency_key: string }
  | { status: "action_not_executed"; decision: "block" | "escalate"; reason_code?: string; human_reason?: string; idempotency_key: string }
  | { status: "action_not_executed"; decision: null; error: string; idempotency_key: string }
  | { status: "execution_failed"; idempotency_key: string }
  | { status: "provider_rejected"; error: string; idempotency_key: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const ARG_KEYS = ["amount_minor", "currency", "order_id"];

// Strict: a plain object with exactly order_id (non-empty string), amount_minor (positive safe integer) and
// currency (three upper-case letters). Each value is read exactly once, into the copy that is then frozen.
// Reflect.ownKeys sees every own key, including non-enumerable and symbol keys, so no extra property can slip by.
function copyRefundArgs(args: unknown): RefundArgs | undefined {
  try {
    if (!isPlainObject(args)) return undefined;
    const ownKeys = Reflect.ownKeys(args);
    if (ownKeys.some((k) => typeof k !== "string")) return undefined;
    const keys = (ownKeys as string[]).sort();
    if (keys.length !== ARG_KEYS.length || keys.some((k, i) => k !== ARG_KEYS[i])) return undefined;
    const order_id: unknown = args.order_id;
    const amount_minor: unknown = args.amount_minor;
    const currency: unknown = args.currency;
    if (typeof order_id !== "string" || order_id.length === 0) return undefined;
    if (typeof amount_minor !== "number" || !Number.isSafeInteger(amount_minor) || amount_minor <= 0) return undefined;
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return undefined;
    // Fixed key order, so the hash and the JSON sent to Salus are the same bytes for the same action.
    return Object.freeze({ order_id, amount_minor, currency });
  } catch {
    // e.g. a throwing getter or proxy trap: not valid arguments.
    return undefined;
  }
}

// Derived from the action only (never from a counter, time or randomness), so a retry of the same refund carries the
// same key. amount_minor and currency have fixed formats, so the key is unambiguous even if order_id contains ":".
export const refundIdempotencyKey = (a: RefundArgs): string => `refund:${a.order_id}:${a.amount_minor}:${a.currency}`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function createProtectedTools(options: { crm: Crm; decide: DecideClient; audit: AuditLog }): ToolDefinition[] {
  const { crm, decide, audit } = options;
  // idempotency_key -> the in-flight execution, shared by concurrent identical calls. Removed once it settles, so a
  // later retry asks Salus again ("every retry is a new proposal") and relies on provider idempotency to pay once.
  const inFlight = new Map<string, Promise<ProtectedRefundResult>>();

  // Post-effect audit writes must not turn a refund that happened into a reported failure; the outcome is still
  // returned truthfully, and the missing "executed" line leaves the key in pendingActions() for reconciliation.
  const tryAppend = (entry: Parameters<AuditLog["append"]>[0]): void => {
    try {
      audit.append(entry);
    } catch {
      // intentionally ignored; see above
    }
  };

  async function decideThenExecute(args: RefundArgs, idempotency_key: string): Promise<ProtectedRefundResult> {
    const args_sha256 = sha256(JSON.stringify(args));
    let result: DecideResult | undefined;
    try {
      result = await decide.decide({ tool_name: TOOL_NAME, idempotency_key, args: { ...args }, mode: "enforce" });
    } catch {
      result = undefined; // the client is documented never to throw; if it does, fail closed below
    }

    const allowed = result !== undefined && result !== null && result.ok === true && result.decision === "allow";
    const decision = result?.ok === true && (result.decision === "allow" || result.decision === "block" || result.decision === "escalate")
      ? result.decision
      : null;

    // "decided" is recorded before any effect. If it cannot be recorded, nothing executes.
    try {
      audit.append({ phase: "decided", idempotency_key, tool_name: TOOL_NAME, args_sha256, decision });
    } catch {
      return { status: "action_not_executed", decision: null, error: "audit_unavailable", idempotency_key };
    }

    if (!allowed) {
      if (decision === "block" || decision === "escalate") {
        // escalate is treated as NOT EXECUTED, PENDING A HUMAN. How a raw HTTP client learns of or waits for the
        // approval is undocumented (contract item 7), and the docs say approving "grants a one-time retry for the
        // same payload; it does not execute the tool". So we never execute on escalate; after approval the caller
        // retries the same call (same frozen args, same key) and it must be decided "allow" again.
        tryAppend({ phase: "not_executed", idempotency_key, reason: decision === "escalate" ? "escalate_pending_human" : "block" });
        const out: ProtectedRefundResult = { status: "action_not_executed", decision, idempotency_key };
        if (result?.ok === true && typeof result.reason_code === "string") out.reason_code = result.reason_code;
        if (result?.ok === true && typeof result.human_reason === "string") out.human_reason = result.human_reason;
        return out;
      }
      // Fail closed: timeout, network, http (401/409/429/503/...), malformed, invalid_request, an unknown decision
      // value, or no usable result at all.
      const error = result?.ok === false && typeof result.error?.kind === "string"
        ? result.error.kind
        : result?.ok === true ? "malformed" : "decide_failed";
      tryAppend({ phase: "not_executed", idempotency_key, reason: `decide_error:${error}` });
      return { status: "action_not_executed", decision: null, error, idempotency_key };
    }

    // The only path to crm.refund: an explicit allow for exactly these frozen args and this key.
    let refund: ReturnType<Crm["refund"]>;
    try {
      refund = crm.refund({ order_id: args.order_id, amount_minor: args.amount_minor, currency: args.currency, idempotency_key });
    } catch {
      // Outcome unknown (the provider may or may not have applied it). No "executed" entry is written, so the key
      // shows up in pendingActions(); retrying the same call is safe because the CRM replays on the same key. The
      // audit phase stays within the contract ("decided" then "executed" or "not_executed"); the reason says the
      // outcome is unknown.
      tryAppend({ phase: "not_executed", idempotency_key, reason: "provider_error_outcome_unknown" });
      return { status: "execution_failed", idempotency_key };
    }
    if (!refund.ok) {
      // A definite refusal by the provider (e.g. exceeds_remaining): nothing was paid.
      tryAppend({ phase: "not_executed", idempotency_key, reason: `provider_rejected:${refund.error}` });
      return { status: "provider_rejected", error: refund.error, idempotency_key };
    }
    tryAppend({ phase: "executed", idempotency_key, refund_id: refund.refund_id, replayed: refund.replayed });
    return { status: "executed", refund_id: refund.refund_id, replayed: refund.replayed, idempotency_key };
  }

  const lookupOrder: ToolDefinition = Object.freeze<ToolDefinition>({
    name: "lookup_order",
    description: "Look up a synthetic order by ID (read-only).",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
    async call(args: Record<string, unknown>) {
      const orderId: unknown = isPlainObject(args) ? args.order_id : undefined;
      if (typeof orderId !== "string" || orderId.length === 0) return { status: "rejected", reason: "invalid_arguments" };
      const order = crm.getOrder(orderId);
      return order ? { status: "ok", order } : { status: "error", error: "not_found" };
    },
  });

  const issueRefund: ToolDefinition = Object.freeze<ToolDefinition>({
    name: TOOL_NAME,
    description: "Refund part or all of an order. Executes only when Salus decides allow (client-side enforcement).",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", minLength: 1 },
        amount_minor: { type: "integer", minimum: 1 },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
      },
      required: ["order_id", "amount_minor", "currency"],
      additionalProperties: false,
    },
    // Not `async`: the copy below must happen synchronously, before the caller gets control back.
    call(raw: Record<string, unknown>): Promise<ProtectedRefundResult> {
      const args = copyRefundArgs(raw);
      if (!args) return Promise.resolve({ status: "rejected", reason: "invalid_arguments" });
      const key = refundIdempotencyKey(args);
      let shared = inFlight.get(key);
      if (!shared) {
        const started = decideThenExecute(args, key).finally(() => inFlight.delete(key));
        inFlight.set(key, started);
        shared = started;
      }
      // Each caller gets its own copy of the shared result.
      return shared.then((r) => ({ ...r }));
    },
  });

  return [lookupOrder, issueRefund];
}
