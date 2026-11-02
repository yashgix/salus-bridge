# `/v1/decide` contract (what the public docs say, and what they don't)

This file is the only source of truth for Salus behaviour in this repo. Where the docs
are silent, the code must **not** invent Salus behaviour: it either treats the case as "not allowed" (fail closed)
or labels the behaviour as our mock's assumption.

Sources: the public Salus docs at `https://docs.usesalus.ai/docs/…`. Pages read: `cloud-custom`, `cloud-api`,
`integration`, `cloud-quickstart`, `hosted-launch`, `security-and-rollout`, `overview` and `changelog`. They were
read on 2 Nov 2026, and the docs' changelog is dated 2 Sep 2026. No account, key or live call was used. Salus
Bridge is an independent, unofficial project, not affiliated with or endorsed by Salus.

## Documented
- **Endpoint:** `POST {base}/decide`. The documented base is `https://app.usesalus.ai/v1` (`SALUS_BASE_URL`).
- **Auth:** `Authorization: Bearer sal_…` (a runtime key). `Content-Type: application/json`.
- **Request body fields** shown in the docs examples:
  - `tool_name`;
  - `tool_id`;
  - `idempotency_key`. It is **required** for `/v1/decide`. The docs say "always send a stable key to prevent
    duplicate processing during retries";
  - `agent_id`;
  - `args` (the tool call arguments);
  - `context` (execution context);
  - `fields` (custom fields for policy evaluation);
  - `mode` (`"enforce"` in the examples; the tool modes are `shadow | enforce | disabled | test`).
- **Response includes:** `decision`, `enforced`, `reason_code`, `human_reason`, `policy_version_id`,
  `policy_version`, `salus_latency_ms`.

  The documented example is `{"decision":"allow","reason_code":"policy_pass","human_reason":"All policy rules
  satisfied","policy_version_id":"pol_v2_abc"}`.
- **Decisions:** `allow`, `block` (optionally with a repair), `escalate`.
  - In enforce mode, "stop on any non-allow".
  - "Every retry is a new proposal": a repaired action must be decided again.
  - "Approving an escalation grants a one-time retry for the same payload; it does not execute the tool."
- **Errors:** standard HTTP status codes with a JSON body `{"detail": …}`:

  | Status | Meaning |
  |---|---|
  | `400` | bad request or missing fields |
  | `401` | missing or invalid key |
  | `403` | insufficient role |
  | `404` | not found |
  | `409` | duplicate idempotency key with different arguments; also a client/server mode mismatch |
  | `422` | schema validation |
  | `429` | rate limited, with `Retry-After` |
  | `503` | service unavailable |
- **Rate limits:** 100 requests per minute per API key.
- **Failure behaviour:**
  - "Fail closed on Salus timeout/error, block on a missing policy".
  - "Unexpected evaluation failures, timeouts, malformed success responses, and quota exhaustion block
    enforce-mode writes under the default contract."
- **Integration guidance:**
  - one enforcement boundary;
  - "no unprotected path to the same side effect";
  - use the provider's idempotency as well as a stable Salus idempotency key.
- **Advisory vs enforced:** a tool registered as `decide_only` gets "advisory verdicts that cannot be promoted to
  enforcement". Hard enforcement is the official SDK wrapper or Salus's proxy. Our TypeScript boundary therefore
  enforces **client-side**; it is not Salus's own enforcement.
- **SDKs:** "Python is supported today. TypeScript support is coming soon."

## Not documented (flagged; do not invent)
1. **The decision ID field in the raw HTTP response.** The SDK has `decision.id`, and `POST /v1/outcomes` takes a
   `decision_id`, but the HTTP field name is not shown. We do not report outcomes; the audit log correlates by
   `idempotency_key`.
2. **The repair payload in the HTTP response.** The SDK names `repair_hint` and `missing_facts`; the HTTP names are
   not shown. We pass unknown fields through as raw data only.
3. **The `revise` decision.** The marketing page lists allow/revise/escalate/block, but the docs only use
   allow/block/escalate. Any other value is treated as malformed, so nothing executes.
4. **Same key, same arguments.** Whether the original decision is replayed is not documented (only the 409 for
   different arguments is). In our mock this is an assumption, labelled as such.
5. **Timeouts and retries.** There is no recommended client timeout or retry policy, other than `Retry-After` for
   429. Ours:
   - a bounded number of attempts;
   - retry only on 429, 503, timeout and network errors;
   - the same body and key on every attempt.
6. **The exact request schema.** Field types, which of `tool_id` and `agent_id` are required, and 400 vs 422 for a
   missing field are not documented.
7. **Escalation follow-up over raw HTTP.** How a client learns the approval ID or waits for it is not shown (only
   the dashboard and admin routes are). We treat `escalate` as "not executed, pending human".
8. **Shadow responses.** The values of `enforced` in shadow are not specified. We only ever execute on
   `decision === "allow"`.
