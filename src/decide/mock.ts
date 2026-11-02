// A local, in-process mock of Salus's `/v1/decide`, used only through an injected `fetch`. It opens no sockets and
// makes no network calls. Contract: docs/decide-contract.md.
//
// What this mock does that IS documented: Bearer auth with 401, a JSON `{ detail }` body on errors, 409 for a
// duplicate idempotency key with different arguments, 429/503 as error statuses, and the decisions allow/block/escalate.
// Everything else below is OUR MOCK'S ASSUMPTION, labelled where it happens, and must not be read as Salus behaviour.

import type { Decision } from "./client.ts";

export type FaultKind = "timeout" | "network" | "malformed" | "http503" | "http429";

export interface MockDecideRequest {
  tool_name: string;
  idempotency_key: string;
  args: Record<string, unknown>;
  [field: string]: unknown;
}

export type MockPolicyResult = Decision | { decision: Decision; reason_code?: string; human_reason?: string };
export type MockPolicy = (request: MockDecideRequest) => MockPolicyResult;

export interface MockSalusOptions {
  apiKey: string;
  policy?: MockPolicy;
}

export interface MockSalus {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  // Copies of the requests the mock accepted (authenticated and valid), in order.
  readonly requests: MockDecideRequest[];
  // How many times the policy actually ran (replays do not count).
  readonly evaluations: number;
  failNext(kind: FaultKind, count?: number): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MOCK_POLICY_VERSION_ID = "mock_pol_v1";

// MOCK ASSUMPTION: the refund thresholds are an example policy of our own, not a documented Salus policy.
//   amount_minor <= 10000  -> allow
//   amount_minor <= 50000  -> escalate
//   above 50000            -> block
// A refund without a non-negative integer amount_minor is blocked. Tools other than issue_refund are allowed.
export const REFUND_ALLOW_MAX_MINOR = 10_000;
export const REFUND_ESCALATE_MAX_MINOR = 50_000;

export const refundPolicy: MockPolicy = (request) => {
  if (request.tool_name !== "issue_refund") {
    return { decision: "allow", reason_code: "mock_not_a_refund", human_reason: "Mock policy only governs refunds" };
  }
  const amount = request.args.amount_minor;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    return { decision: "block", reason_code: "mock_invalid_amount", human_reason: "Refund amount is not a valid integer" };
  }
  if (amount <= REFUND_ALLOW_MAX_MINOR) {
    return { decision: "allow", reason_code: "mock_refund_within_auto_limit", human_reason: "Refund within the automatic limit" };
  }
  if (amount <= REFUND_ESCALATE_MAX_MINOR) {
    return { decision: "escalate", reason_code: "mock_refund_needs_approval", human_reason: "Refund needs human approval" };
  }
  return { decision: "block", reason_code: "mock_refund_over_limit", human_reason: "Refund above the maximum limit" };
};

export function createMockSalus(options: MockSalusOptions): MockSalus {
  const apiKey = options.apiKey;
  const policy = options.policy ?? refundPolicy;
  const requests: MockDecideRequest[] = [];
  const faults: FaultKind[] = [];
  // idempotency_key -> fingerprint of the args and the first response body.
  const seen = new Map<string, { argsFingerprint: string; body: Record<string, unknown> }>();
  let evaluations = 0;

  async function mockFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");

    // MOCK ASSUMPTION (fault injection): these faults are our own test tooling, applied before anything else, to
    // exercise the client's fail-closed paths. They do not describe how Salus fails.
    const fault = faults.shift();
    if (fault === "timeout") return hangUntilAborted(signal); // never answers; only an abort ends it
    if (fault === "network") throw new TypeError("fetch failed (mock network fault)");
    if (fault === "malformed") return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (fault === "http503") return json(503, { detail: "Service unavailable (mock fault)" });
    if (fault === "http429") return json(429, { detail: "Rate limited (mock fault)" }, { "retry-after": "1" });

    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (!url.pathname.endsWith("/decide")) return json(404, { detail: "Not found" });
    if (method !== "POST") return json(404, { detail: "Not found" });

    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (auth !== `Bearer ${apiKey}` || apiKey.length === 0) return json(401, { detail: "Missing or invalid API key" });

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof init.body === "string" ? init.body : "");
    } catch {
      return json(400, { detail: "Body is not valid JSON" });
    }
    // MOCK ASSUMPTION (contract item 6): the docs do not say whether a missing field is 400 or 422. Our mock returns
    // 400 for a missing required field (tool_name, idempotency_key, args) and 422 for a field of the wrong type.
    if (!isObject(parsed)) return json(422, { detail: "Body must be a JSON object" });
    for (const field of ["tool_name", "idempotency_key", "args"]) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
        return json(400, { detail: `Missing required field: ${field}` });
      }
    }
    if (typeof parsed.tool_name !== "string") return json(422, { detail: "tool_name must be a string" });
    if (typeof parsed.idempotency_key !== "string") return json(422, { detail: "idempotency_key must be a string" });
    if (!isObject(parsed.args)) return json(422, { detail: "args must be an object" });
    const request = parsed as MockDecideRequest;

    const argsFingerprint = canonical(request.args);
    const previous = seen.get(request.idempotency_key);
    if (previous && previous.argsFingerprint !== argsFingerprint) {
      // Documented: a duplicate idempotency key with different arguments is 409.
      return json(409, { detail: "Duplicate idempotency key with different arguments" });
    }
    requests.push(structuredClone(request));
    if (previous) {
      // MOCK ASSUMPTION (contract item 4): replaying the first decision for the same key and same arguments is our
      // mock's choice; the docs do not say what Salus does in this case.
      return json(200, previous.body);
    }

    const started = performance.now();
    evaluations += 1;
    const verdict = policy(structuredClone(request));
    const decided = typeof verdict === "string" ? { decision: verdict } : verdict;
    const body: Record<string, unknown> = {
      decision: decided.decision,
      enforced: request.mode === "enforce",
      reason_code: decided.reason_code ?? `mock_${decided.decision}`,
      human_reason: decided.human_reason ?? `Mock policy returned ${decided.decision}`,
      policy_version_id: MOCK_POLICY_VERSION_ID,
      salus_latency_ms: Math.round(performance.now() - started),
    };
    seen.set(request.idempotency_key, { argsFingerprint, body });
    return json(200, body);
  }

  return {
    fetch: mockFetch,
    requests,
    get evaluations() { return evaluations; },
    failNext(kind: FaultKind, count = 1) {
      for (let i = 0; i < count; i += 1) faults.push(kind);
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function hangUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
  });
}

// Key-order-independent JSON, so { a, b } and { b, a } count as the same arguments.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
