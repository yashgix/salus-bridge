// Client for Salus's documented `POST {base}/decide` endpoint. Contract: docs/decide-contract.md.
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// Fail-closed rules we follow from the contract:
// - only the documented decisions `allow`, `block` and `escalate` are accepted; anything else (including the
//   undocumented `revise`), a non-object body or a non-JSON body is an error of kind "malformed" (contract item 3);
// - the client never throws: every failure resolves to `{ ok: false, error }`, so a caller cannot execute by accident;
// - the API key is only ever put in the Authorization header and is scrubbed from anything we return.

export type Decision = "allow" | "block" | "escalate";

export interface DecideRequest {
  tool_name: string;
  idempotency_key: string;
  args: Record<string, unknown>;
  context?: unknown;
  fields?: unknown;
  agent_id?: string;
  tool_id?: string;
  mode?: string;
}

export type DecideErrorKind = "invalid_request" | "timeout" | "network" | "http" | "malformed";

export interface DecideError {
  kind: DecideErrorKind;
  status?: number;
  detail?: unknown;
}

export interface DecideAllowed {
  ok: true;
  decision: Decision;
  enforced?: boolean;
  reason_code?: string;
  human_reason?: string;
  policy_version_id?: string;
  policy_version?: string | number;
  salus_latency_ms?: number;
  attempts: number;
  // The full parsed response. Undocumented fields (e.g. a decision ID or repair payload, contract items 1 and 2)
  // are passed through here as raw data only; this client does not interpret them.
  raw: Record<string, unknown>;
}

export interface DecideFailed {
  ok: false;
  attempts: number;
  error: DecideError;
}

export type DecideResult = DecideAllowed | DecideFailed;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DecideClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DecideClient {
  decide(request: DecideRequest): Promise<DecideResult>;
}

// Request body fields shown in the docs examples. Only these are sent.
const BODY_FIELDS = ["tool_name", "tool_id", "idempotency_key", "agent_id", "args", "context", "fields", "mode"] as const;
const DECISIONS: readonly string[] = ["allow", "block", "escalate"];

// OUR local timeout and retry policy, not Salus's (contract item 5: the docs recommend no client timeout or retry
// policy, other than honouring `Retry-After` on 429). We make a bounded number of attempts, retry only on 429, 503,
// a timeout or a network error, and send the identical body (and so the identical idempotency key) every time.
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
// A 429 asking us to wait longer than this is returned to the caller rather than retried (never retried early).
const MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function createDecideClient(options: DecideClientOptions): DecideClient {
  const url = String(options.baseUrl).replace(/\/+$/, "") + "/decide";
  const apiKey = options.apiKey;
  const doFetch = options.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.floor(positiveOr(options.maxAttempts, DEFAULT_MAX_ATTEMPTS));

  // Removes any copy of the API key from a value we are about to return (e.g. a server echoing it in `detail`).
  const scrub = <T>(value: T): T => {
    if (!nonEmptyString(apiKey)) return value;
    if (typeof value === "string") return value.split(apiKey).join("[redacted]") as T;
    if (Array.isArray(value)) return value.map(scrub) as T;
    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[scrub(k)] = scrub(v);
      return out as T;
    }
    return value;
  };

  async function attemptOnce(body: string): Promise<{ result: DecideResult; retry: boolean; retryAfterMs?: number }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timeout is enforced here even if the injected fetch ignores the abort signal.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("decide request timed out", "TimeoutError"));
        resolve("timeout");
      }, timeoutMs);
    });
    const fail = (error: DecideError, retry: boolean, retryAfterMs?: number) =>
      ({ result: { ok: false as const, attempts: 0, error }, retry, retryAfterMs });
    try {
      const exchange = (async () => {
        const res = await doFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
          body,
          signal: controller.signal,
          redirect: "manual",
        });
        const text = await res.text();
        return { res, text };
      })();
      exchange.catch(() => {}); // a late rejection after a timeout must not become unhandled
      const outcome = await Promise.race([exchange, timeout]);
      if (outcome === "timeout") return fail({ kind: "timeout" }, true);
      const { res, text } = outcome;
      const parsed = parseJson(text);

      if (res.status >= 200 && res.status < 300) {
        if (!isObject(parsed) || typeof parsed.decision !== "string" || !DECISIONS.includes(parsed.decision)) {
          return fail({ kind: "malformed", status: res.status }, false);
        }
        return { result: toAllowed(parsed), retry: false };
      }

      const detail = isObject(parsed) && "detail" in parsed ? parsed.detail : undefined;
      const error: DecideError = detail === undefined ? { kind: "http", status: res.status } : { kind: "http", status: res.status, detail };
      if (res.status === 429) {
        const { retry, retryAfterMs } = retryAfter429(res.headers.get("retry-after"));
        return fail(error, retry, retryAfterMs);
      }
      if (res.status === 503) return fail(error, true);
      // 400, 401, 403, 404, 409, 422 (documented) and any other status: reported, never retried.
      return fail(error, false);
    } catch {
      if (timedOut) return fail({ kind: "timeout" }, true);
      return fail({ kind: "network" }, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(body: string): Promise<DecideResult> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const { result, retry, retryAfterMs } = await attemptOnce(body);
      result.attempts = attempts;
      if (!retry || attempts >= maxAttempts) return scrub(result);
      // Our backoff (contract item 5): Retry-After when a 429 gives one, otherwise exponential from BACKOFF_BASE_MS.
      await sleep(retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempts - 1));
    }
  }

  function decide(request: DecideRequest): Promise<DecideResult> {
    // Everything up to `send` runs synchronously, so the body is fixed at the moment decide() is called and later
    // changes to `request` by the caller cannot alter what is sent or retried.
    try {
      const body = prepareBody(request);
      if (body === null) return Promise.resolve({ ok: false, attempts: 0, error: { kind: "invalid_request" } });
      return send(body).catch(() => scrub({ ok: false as const, attempts: 0, error: { kind: "network" as const } }));
    } catch {
      return Promise.resolve({ ok: false, attempts: 0, error: { kind: "invalid_request" } });
    }
  }

  return { decide };
}

// Copies the documented fields into a JSON string and validates that copy (what we validate is what we send).
// Returns null when tool_name, idempotency_key (required by the docs) or args is missing.
function prepareBody(request: unknown): string | null {
  if (!isObject(request)) return null;
  const picked: Record<string, unknown> = {};
  for (const field of BODY_FIELDS) if (request[field] !== undefined) picked[field] = request[field];
  const body = JSON.stringify(picked);
  const copy: unknown = JSON.parse(body);
  if (!isObject(copy) || !nonEmptyString(copy.tool_name) || !nonEmptyString(copy.idempotency_key) || !isObject(copy.args)) {
    return null;
  }
  return body;
}

function toAllowed(raw: Record<string, unknown>): DecideAllowed {
  const out: DecideAllowed = { ok: true, decision: raw.decision as Decision, attempts: 0, raw };
  if (typeof raw.enforced === "boolean") out.enforced = raw.enforced;
  if (typeof raw.reason_code === "string") out.reason_code = raw.reason_code;
  if (typeof raw.human_reason === "string") out.human_reason = raw.human_reason;
  if (typeof raw.policy_version_id === "string") out.policy_version_id = raw.policy_version_id;
  if (typeof raw.policy_version === "string" || typeof raw.policy_version === "number") out.policy_version = raw.policy_version;
  if (typeof raw.salus_latency_ms === "number") out.salus_latency_ms = raw.salus_latency_ms;
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Retry-After is either delay-seconds or an HTTP date. The requested delay is never shortened: when it is longer
// than our MAX_RETRY_AFTER_MS (our policy), we do not retry at all and return the 429 instead.
function retryAfter429(value: string | null): { retry: boolean; retryAfterMs?: number } {
  const ms = parseRetryAfter(value);
  if (ms === undefined) return { retry: true };
  if (ms > MAX_RETRY_AFTER_MS) return { retry: false };
  return { retry: true, retryAfterMs: ms };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback;
}
