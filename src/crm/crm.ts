// A small in-memory CRM with synthetic orders, used as the "provider" side effect in the examples and tests.
// All data here is made up (synthetic IDs, no real customers). Nothing is persisted and nothing touches the network.
//
// refund() follows safe provider rules: integer positive amounts, matching currency, no refund beyond the remaining
// balance, and provider-side idempotency (the same key and payload replays the first refund; the same key with a
// different payload is an idempotency_conflict). updateOrder() is an unguarded admin write path, kept on purpose so
// the flawed integration can show what an "alternate path to the same side effect" looks like.

export interface Order {
  order_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  refunded_minor: number;
}

export interface RefundRequest {
  order_id: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string;
}

export interface RefundRecord {
  refund_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string;
}

export type RefundError = "not_found" | "invalid_amount" | "currency_mismatch" | "exceeds_remaining" | "idempotency_conflict";

export type RefundResult =
  | { ok: true; refund_id: string; order_id: string; amount_minor: number; currency: string; replayed: boolean }
  | { ok: false; error: RefundError };

export type OrderPatch = Partial<Omit<Order, "order_id">>;

export interface Crm {
  getOrder(orderId: string): Order | undefined;
  refund(request: RefundRequest): RefundResult;
  updateOrder(orderId: string, patch: OrderPatch): { ok: boolean; order?: Order };
  refunds(): RefundRecord[];
  failNextRefund(options?: { afterEffect?: boolean }): void;
}

// Synthetic seed data. ORD-1004 is in EUR so currency mismatches can be shown.
const SEED: readonly Order[] = [
  { order_id: "ORD-1001", customer_id: "C-1", amount_minor: 4500, currency: "USD", refunded_minor: 0 },
  { order_id: "ORD-1002", customer_id: "C-2", amount_minor: 25000, currency: "USD", refunded_minor: 0 },
  { order_id: "ORD-1003", customer_id: "C-3", amount_minor: 90000, currency: "USD", refunded_minor: 0 },
  { order_id: "ORD-1004", customer_id: "C-4", amount_minor: 12000, currency: "EUR", refunded_minor: 0 },
];

const PATCHABLE = ["customer_id", "amount_minor", "currency", "refunded_minor"] as const;

export function createCrm(): Crm {
  const orders = new Map<string, Order>(SEED.map((o) => [o.order_id, { ...o }]));
  const executed: RefundRecord[] = [];
  // idempotency_key -> the refund it produced (provider-side idempotency).
  const byKey = new Map<string, RefundRecord>();
  let pendingFailure: { afterEffect: boolean } | undefined;

  const success = (r: RefundRecord, replayed: boolean): RefundResult =>
    ({ ok: true, refund_id: r.refund_id, order_id: r.order_id, amount_minor: r.amount_minor, currency: r.currency, replayed });

  function apply(request: RefundRequest): RefundResult {
    const { order_id, amount_minor, currency, idempotency_key } = request;
    const previous = byKey.get(idempotency_key);
    if (previous) {
      const same = previous.order_id === order_id && previous.amount_minor === amount_minor && previous.currency === currency;
      return same ? success(previous, true) : { ok: false, error: "idempotency_conflict" };
    }
    const order = orders.get(order_id);
    if (!order) return { ok: false, error: "not_found" };
    if (typeof amount_minor !== "number" || !Number.isInteger(amount_minor) || amount_minor <= 0) {
      return { ok: false, error: "invalid_amount" };
    }
    if (currency !== order.currency) return { ok: false, error: "currency_mismatch" };
    if (amount_minor > order.amount_minor - order.refunded_minor) return { ok: false, error: "exceeds_remaining" };

    // Deterministic IDs (a counter), so the same script always produces the same transcript.
    const record: RefundRecord = { refund_id: `RF-${String(executed.length + 1).padStart(4, "0")}`, order_id, amount_minor, currency, idempotency_key };
    order.refunded_minor += amount_minor;
    executed.push(record);
    byKey.set(idempotency_key, record);
    return success(record, false);
  }

  return {
    getOrder(orderId) {
      const order = orders.get(orderId);
      return order ? { ...order } : undefined;
    },

    refund(request) {
      const failure = pendingFailure;
      pendingFailure = undefined;
      // Simulated provider failure: before the effect (nothing happened), or after it (applied, but the caller
      // cannot know the outcome).
      if (failure && !failure.afterEffect) throw new Error("crm refund failed (simulated, before effect)");
      const result = apply({ ...request });
      if (failure) throw new Error("crm refund failed (simulated, after effect; outcome unknown)");
      return result;
    },

    // Admin write path: no checks beyond the order existing and the field being known.
    updateOrder(orderId, patch) {
      const order = orders.get(orderId);
      if (!order || typeof patch !== "object" || patch === null) return { ok: false };
      Object.assign(order, Object.fromEntries(PATCHABLE.filter((f) => patch[f] !== undefined).map((f) => [f, patch[f]])));
      return { ok: true, order: { ...order } };
    },

    refunds() {
      return executed.map((r) => ({ ...r }));
    },

    failNextRefund(options = {}) {
      pendingFailure = { afterEffect: options.afterEffect === true };
    },
  };
}
