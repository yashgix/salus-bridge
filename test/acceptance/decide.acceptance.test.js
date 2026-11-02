// Acceptance tests: the contract for the /v1/decide client and the local mock.
// Contract: docs/decide-contract.md. Interfaces required by these tests:
//   src/decide/client.ts  export function createDecideClient({ baseUrl, apiKey, fetch, timeoutMs?, maxAttempts?, sleep? })
//                         -> { decide(request) }   request: { tool_name, idempotency_key, args, context?, fields?,
//                         agent_id?, tool_id?, mode? }. decide() copies the request synchronously when called
//                         (later changes by the caller cannot alter what is sent). It never throws; it resolves to
//                         { ok: true, decision: "allow"|"block"|"escalate", enforced?, reason_code?, human_reason?,
//                           policy_version_id?, policy_version?, salus_latency_ms?, attempts, raw }
//                       | { ok: false, attempts, error: { kind: "invalid_request"|"timeout"|"network"|"http"|"malformed",
//                           status?, detail? } }
//   src/decide/mock.ts    export function createMockSalus({ apiKey, policy? }) -> { fetch, requests, evaluations,
//                         failNext(kind, count?) }   kind: "timeout"|"network"|"malformed"|"http503"|"http429"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecideClient } from '../../src/decide/client.ts';
import { createMockSalus } from '../../src/decide/mock.ts';

const KEY = 'sal_test_acceptance_key';
const BASE = 'https://app.usesalus.ai/v1';
const noSleep = () => Promise.resolve();
const req = (over = {}) => ({ tool_name: 'issue_refund', idempotency_key: 'refund:ORD-1001:1000:USD',
  args: { order_id: 'ORD-1001', amount_minor: 1000, currency: 'USD' }, mode: 'enforce', ...over });
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function recorder(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(url, init) : next.clone();
  };
  return { calls, fetch };
}

test('T1.1 sends the documented request: POST {base}/decide, Bearer key, JSON body with exactly the given fields', async () => {
  const r = recorder([json(200, { decision: 'allow', reason_code: 'policy_pass' })]);
  const c = createDecideClient({ baseUrl: BASE + '/', apiKey: KEY, fetch: r.fetch, sleep: noSleep });
  const body = req({ context: { user_id: 'C-1' }, fields: { risk_score: 0.1 }, agent_id: 'agent_demo', tool_id: 'tool_demo' });
  await c.decide(body);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://app.usesalus.ai/v1/decide');
  assert.equal(r.calls[0].init.method, 'POST');
  const h = new Headers(r.calls[0].init.headers);
  assert.equal(h.get('authorization'), `Bearer ${KEY}`);
  assert.match(h.get('content-type') || '', /^application\/json/);
  assert.deepEqual(JSON.parse(r.calls[0].init.body), body);
});

test('T1.2 parses documented allow, block and escalate responses and keeps the raw body', async () => {
  for (const decision of ['allow', 'block', 'escalate']) {
    const raw = { decision, enforced: true, reason_code: 'rc_' + decision, human_reason: 'because', policy_version_id: 'pol_v2_abc',
      policy_version: 3, salus_latency_ms: 12, repair_hint: { kind: 'retry_with_changes' } };
    const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: recorder([json(200, raw)]).fetch, sleep: noSleep });
    const out = await c.decide(req());
    assert.equal(out.ok, true);
    assert.equal(out.decision, decision);
    assert.equal(out.enforced, true);
    assert.equal(out.reason_code, 'rc_' + decision);
    assert.equal(out.human_reason, 'because');
    assert.equal(out.policy_version_id, 'pol_v2_abc');
    assert.equal(out.salus_latency_ms, 12);
    assert.equal(out.attempts, 1);
    assert.deepEqual(out.raw, raw);
  }
});

test('T1.3 an undocumented or malformed success response is never an allow (fail closed)', async () => {
  const bad = [
    json(200, { decision: 'revise' }), json(200, { decision: 'ALLOW' }), json(200, { reason_code: 'x' }), json(200, ['allow']),
    json(200, { decision: null }), new Response('allow', { status: 200 }), new Response('', { status: 200 }),
  ];
  for (const resp of bad) {
    const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: recorder([resp]).fetch, sleep: noSleep, maxAttempts: 1 });
    const out = await c.decide(req());
    assert.equal(out.ok, false);
    assert.equal(out.error.kind, 'malformed');
  }
});

test('T1.4 documented client errors are returned with status and detail and are not retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const r = recorder([json(status, { detail: `detail ${status}` })]);
    const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: r.fetch, sleep: noSleep, maxAttempts: 3 });
    const out = await c.decide(req());
    assert.equal(out.ok, false);
    assert.equal(out.error.kind, 'http');
    assert.equal(out.error.status, status);
    assert.equal(out.error.detail, `detail ${status}`);
    assert.equal(r.calls.length, 1, `status ${status} must not be retried`);
  }
});

test('T1.5 429 honours Retry-After and retries with the identical body and idempotency key', async () => {
  const r = recorder([json(429, { detail: 'slow down' }, { 'retry-after': '2' }), json(200, { decision: 'allow' })]);
  const waits = [];
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: r.fetch, sleep: (ms) => { waits.push(ms); return Promise.resolve(); }, maxAttempts: 3 });
  const out = await c.decide(req());
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].init.body, r.calls[0].init.body);
});

test('T1.6 503 and network errors are retried up to maxAttempts, then reported; never more attempts', async () => {
  const r = recorder([json(503, { detail: 'unavailable' })]);
  const waits = [];
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: r.fetch, sleep: (ms) => { waits.push(ms); return Promise.resolve(); }, maxAttempts: 3 });
  const out = await c.decide(req());
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'http');
  assert.equal(out.error.status, 503);
  assert.equal(out.attempts, 3);
  assert.equal(r.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(new Set(r.calls.map((x) => x.init.body)).size === 1, 'every attempt sends the same body');

  const n = recorder([() => Promise.reject(new TypeError('fetch failed')), json(200, { decision: 'block' })]);
  const c2 = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: n.fetch, sleep: noSleep, maxAttempts: 2 });
  const out2 = await c2.decide(req());
  assert.equal(out2.ok, true);
  assert.equal(out2.decision, 'block');
  assert.equal(out2.attempts, 2);

  const dead = recorder([() => Promise.reject(new TypeError('fetch failed'))]);
  const out3 = await createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: dead.fetch, sleep: noSleep, maxAttempts: 2 }).decide(req());
  assert.equal(out3.ok, false);
  assert.equal(out3.error.kind, 'network');
  assert.equal(dead.calls.length, 2);
});

test('T1.7 a request that does not answer within timeoutMs is aborted and reported as timeout', async () => {
  let aborted = 0;
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted += 1; reject(init.signal.reason ?? new Error('aborted')); });
  });
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: hang, sleep: noSleep, timeoutMs: 30, maxAttempts: 2 });
  const t0 = performance.now();
  const out = await c.decide(req());
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'timeout');
  assert.equal(out.attempts, 2);
  assert.equal(aborted, 2);
  assert.ok(performance.now() - t0 < 2000, 'timeout must be enforced by the client');
});

test('T1.8 a request without tool_name or idempotency_key is refused locally; the key never leaks into results', async () => {
  const r = recorder([json(200, { decision: 'allow' })]);
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: r.fetch, sleep: noSleep });
  for (const bad of [req({ idempotency_key: '' }), req({ idempotency_key: undefined }), req({ tool_name: '' }), req({ args: null })]) {
    const out = await c.decide(bad);
    assert.equal(out.ok, false);
    assert.equal(out.error.kind, 'invalid_request');
    assert.ok(!JSON.stringify(out).includes(KEY));
  }
  assert.equal(r.calls.length, 0);
  const e = await createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: recorder([json(401, { detail: 'bad key' })]).fetch, sleep: noSleep }).decide(req());
  assert.ok(!JSON.stringify(e).includes(KEY));
});

test('T1.9 mock: documented refund policy example (allow <= 10000, escalate <= 50000, block above), auth required', async () => {
  const mock = createMockSalus({ apiKey: KEY });
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: mock.fetch, sleep: noSleep });
  const d = async (amount) => (await c.decide(req({ idempotency_key: `k-${amount}`, args: { order_id: 'ORD-1003', amount_minor: amount, currency: 'USD' } })));
  assert.equal((await d(1000)).decision, 'allow');
  assert.equal((await d(10000)).decision, 'allow');
  assert.equal((await d(20000)).decision, 'escalate');
  assert.equal((await d(60000)).decision, 'block');
  assert.equal(mock.requests.length, 4);
  assert.equal(mock.requests[0].args.amount_minor, 1000);
  const wrong = await createDecideClient({ baseUrl: BASE, apiKey: 'sal_wrong', fetch: mock.fetch, sleep: noSleep }).decide(req());
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.status, 401);
  const missing = await mock.fetch(BASE + '/decide', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool_name: 'issue_refund', args: {} }) });
  assert.ok([400, 422].includes(missing.status));
  assert.ok(typeof (await missing.json()).detail === 'string');
});

test('T1.10 mock: same key + same args replays the first decision; same key + different args is 409', async () => {
  let calls = 0;
  const mock = createMockSalus({ apiKey: KEY, policy: () => { calls += 1; return calls === 1 ? 'allow' : 'block'; } });
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: mock.fetch, sleep: noSleep });
  const a = await c.decide(req());
  const b = await c.decide(req());
  assert.equal(a.decision, 'allow');
  assert.equal(b.decision, 'allow');
  assert.equal(mock.evaluations, 1);
  const conflict = await c.decide(req({ args: { order_id: 'ORD-1001', amount_minor: 9999, currency: 'USD' } }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.status, 409);
});

test('T1.11 mock faults: 503, 429, timeout, network and malformed behave as documented failures', async () => {
  const mock = createMockSalus({ apiKey: KEY });
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: mock.fetch, sleep: noSleep, timeoutMs: 30, maxAttempts: 2 });
  for (const kind of ['http503', 'http429', 'timeout', 'network']) {
    mock.failNext(kind);
    const out = await c.decide(req({ idempotency_key: 'fault-' + kind }));
    assert.equal(out.ok, true, `${kind} once, then success`);
    assert.equal(out.attempts, 2);
  }
  mock.failNext('malformed');
  const m = await c.decide(req({ idempotency_key: 'fault-malformed' }));
  assert.equal(m.ok, false);
  assert.equal(m.error.kind, 'malformed');
  mock.failNext('timeout', 5);
  const t = await c.decide(req({ idempotency_key: 'fault-timeout-2' }));
  assert.equal(t.ok, false);
  assert.equal(t.error.kind, 'timeout');
});

test('T1.12 the request is captured when decide() is called; changing it afterwards cannot change what is sent', async () => {
  const mock = createMockSalus({ apiKey: KEY });
  const c = createDecideClient({ baseUrl: BASE, apiKey: KEY, fetch: mock.fetch, sleep: noSleep });
  const r = req({ idempotency_key: 'capture-1' });
  const p = c.decide(r);
  r.args.amount_minor = 60000; r.idempotency_key = 'changed';
  await p;
  assert.equal(mock.requests[0].args.amount_minor, 1000);
  assert.equal(mock.requests[0].idempotency_key, 'capture-1');
});
