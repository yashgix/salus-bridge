// Acceptance tests: the contract for the corrected execution boundary. Interfaces:
//   src/integrations/audit.ts     export function createAuditLog(file?) -> { append(entry), entries() }: append-only;
//                                 entries() returns copies; with `file`, entries are JSON lines appended to that file and
//                                 a new log on the same file sees the earlier entries (restart).
//                                 export function pendingActions(audit) -> idempotency keys that were allowed but have no
//                                 "executed" entry yet (allowed, then a crash or an execution failure).
//   src/integrations/protected.ts export function createProtectedTools({ crm, decide, audit }) -> tools named lookup_order
//                                 and issue_refund ONLY (no other write path). issue_refund(args):
//     - args must be exactly { order_id: string, amount_minor: positive integer, currency: 3 upper-case letters };
//       anything else -> { status: "rejected", reason: "invalid_arguments" }, no decision, no effect;
//     - the arguments are copied and frozen when the call starts; that copy is what Salus decides on AND what executes;
//     - idempotency_key is derived from the action only: `refund:${order_id}:${amount_minor}:${currency}`; the same key
//       is sent to Salus and to crm.refund;
//     - only { ok: true, decision: "allow" } executes -> { status: "executed", refund_id, replayed, idempotency_key };
//       block/escalate -> { status: "action_not_executed", decision, reason_code?, human_reason? };
//       any decide error -> { status: "action_not_executed", decision: null, error: <kind> } (fail closed);
//       crm.refund throws after an allow -> { status: "execution_failed", idempotency_key }: the outcome is unknown
//       (the refund may or may not have been applied); retrying later is safe;
//     - concurrent calls for the same action share one execution;
//     - audit entries: { phase: "decided", idempotency_key, tool_name, args_sha256, decision } before any effect, then
//       { phase: "executed", idempotency_key, refund_id }, or { phase: "not_executed", idempotency_key, reason } when it
//       is certain nothing was paid, or { phase: "outcome_unknown", idempotency_key, reason } when the provider threw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrm } from '../../src/crm/crm.ts';
import { runScriptedAgent } from '../../src/agent/scripted.ts';
import { createProtectedTools } from '../../src/integrations/protected.ts';
import { createAuditLog, pendingActions } from '../../src/integrations/audit.ts';
import { createDecideClient } from '../../src/decide/client.ts';
import { createMockSalus } from '../../src/decide/mock.ts';

const KEY = 'sal_test_acceptance_key';
function world({ file, crm } = {}) {
  crm = crm || createCrm(); const mock = createMockSalus({ apiKey: KEY }); const audit = createAuditLog(file);
  const decide = createDecideClient({ baseUrl: 'https://app.usesalus.ai/v1', apiKey: KEY, fetch: mock.fetch, sleep: () => Promise.resolve(), timeoutMs: 30, maxAttempts: 1 });
  const tools = createProtectedTools({ crm, decide, audit });
  const call = (name, args) => tools.find((t) => t.name === name).call(args);
  return { crm, mock, audit, decide, tools, call };
}
const R = (order_id, amount_minor, currency = 'USD') => ({ order_id, amount_minor, currency });

test('T3.1 only lookup_order and issue_refund exist; the alternate write path is gone', async () => {
  const w = world();
  assert.deepEqual(w.tools.map((t) => t.name).sort(), ['issue_refund', 'lookup_order']);
  const out = await runScriptedAgent({ tools: w.tools, script: [{ tool: 'update_order', args: { order_id: 'ORD-1003', patch: { refunded_minor: 90000 } } }] });
  assert.deepEqual(out.transcript[0].result, { status: 'error', error: 'unknown_tool' });
  assert.equal(w.crm.getOrder('ORD-1003').refunded_minor, 0);
  assert.equal(w.mock.requests.length, 0);
});

test('T3.2 allow executes exactly the decided action with one idempotency key end to end', async () => {
  const w = world();
  const out = await w.call('issue_refund', R('ORD-1001', 1000));
  assert.equal(out.status, 'executed');
  assert.equal(out.idempotency_key, 'refund:ORD-1001:1000:USD');
  assert.equal(w.mock.requests.length, 1);
  const sent = w.mock.requests[0];
  assert.equal(sent.tool_name, 'issue_refund');
  assert.equal(sent.idempotency_key, 'refund:ORD-1001:1000:USD');
  assert.deepEqual(sent.args, R('ORD-1001', 1000));
  const paid = w.crm.refunds();
  assert.equal(paid.length, 1);
  assert.deepEqual({ order_id: paid[0].order_id, amount_minor: paid[0].amount_minor, currency: paid[0].currency }, sent.args);
  assert.equal(paid[0].refund_id, out.refund_id);
});

test('T3.3 block and escalate never execute and are reported with the decision', async () => {
  const w = world();
  const b = await w.call('issue_refund', R('ORD-1003', 60000));
  assert.equal(b.status, 'action_not_executed'); assert.equal(b.decision, 'block');
  const e = await w.call('issue_refund', R('ORD-1002', 20000));
  assert.equal(e.status, 'action_not_executed'); assert.equal(e.decision, 'escalate');
  assert.equal(w.crm.refunds().length, 0);
});

test('T3.4 arguments changed after the call starts cannot change what executes', async () => {
  const w = world();
  const out = await runScriptedAgent({ tools: w.tools, script: [{ tool: 'issue_refund', args: R('ORD-1003', 5000), tamper: (a) => { a.amount_minor = 60000; } }] });
  assert.equal(out.transcript[0].result.status, 'executed');
  assert.equal(w.mock.requests[0].args.amount_minor, 5000);
  assert.equal(w.crm.refunds()[0].amount_minor, 5000);
  assert.equal(w.crm.getOrder('ORD-1003').refunded_minor, 5000);
});

test('T3.5 fail closed: timeout, network error, 503, malformed and 401 all mean no refund', async () => {
  for (const kind of ['timeout', 'network', 'http503', 'malformed']) {
    const w = world();
    w.mock.failNext(kind);
    const out = await w.call('issue_refund', R('ORD-1001', 1000));
    assert.equal(out.status, 'action_not_executed', kind);
    assert.equal(out.decision, null);
    assert.equal(typeof out.error, 'string');
    assert.equal(w.crm.refunds().length, 0, kind);
  }
  const crm = createCrm(); const mock = createMockSalus({ apiKey: KEY });
  const decide = createDecideClient({ baseUrl: 'https://app.usesalus.ai/v1', apiKey: 'sal_wrong', fetch: mock.fetch, sleep: () => Promise.resolve(), maxAttempts: 1 });
  const tools = createProtectedTools({ crm, decide, audit: createAuditLog() });
  const out = await tools.find((t) => t.name === 'issue_refund').call(R('ORD-1001', 1000));
  assert.equal(out.status, 'action_not_executed');
  assert.equal(crm.refunds().length, 0);
});

test('T3.6 invalid or extra arguments are rejected before any decision or effect', async () => {
  const w = world();
  const bad = [{ order_id: 'ORD-1001', amount_minor: 1000 }, { ...R('ORD-1001', 1000), note: 'x' }, R('ORD-1001', -5), R('ORD-1001', 10.5),
    R('ORD-1001', '1000'), R('ORD-1001', 1000, 'usd'), R(42, 1000), null];
  for (const a of bad) {
    const out = await w.call('issue_refund', a);
    assert.deepEqual(out, { status: 'rejected', reason: 'invalid_arguments' });
  }
  assert.equal(w.mock.requests.length, 0);
  assert.equal(w.crm.refunds().length, 0);
});

test('T3.7 retries and concurrent duplicates pay once', async () => {
  const w = world();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => w.call('issue_refund', R('ORD-1002', 3000))));
  for (const r of [a, b, c]) assert.equal(r.status, 'executed');
  assert.equal(new Set([a, b, c].map((r) => r.refund_id)).size, 1);
  const again = await w.call('issue_refund', R('ORD-1002', 3000));
  assert.equal(again.status, 'executed'); assert.equal(again.refund_id, a.refund_id);
  assert.equal(w.crm.refunds().length, 1);
  assert.equal(w.crm.getOrder('ORD-1002').refunded_minor, 3000);

  const t = world();
  t.mock.failNext('timeout');
  assert.equal((await t.call('issue_refund', R('ORD-1001', 1000))).status, 'action_not_executed');
  assert.equal((await t.call('issue_refund', R('ORD-1001', 1000))).status, 'executed');
  assert.equal(t.crm.refunds().length, 1);
});

test('T3.8 audit: decided before effect, then executed, not_executed or outcome_unknown; append-only copies; hashes of exact args', async () => {
  const w = world();
  await w.call('issue_refund', R('ORD-1001', 1000));
  await w.call('issue_refund', R('ORD-1003', 60000));
  const e = w.audit.entries();
  assert.deepEqual(e.map((x) => [x.phase, x.idempotency_key]), [
    ['decided', 'refund:ORD-1001:1000:USD'], ['executed', 'refund:ORD-1001:1000:USD'],
    ['decided', 'refund:ORD-1003:60000:USD'], ['not_executed', 'refund:ORD-1003:60000:USD']]);
  assert.equal(e[0].decision, 'allow'); assert.equal(e[0].tool_name, 'issue_refund'); assert.match(e[0].args_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(e[0].args_sha256, e[2].args_sha256);
  assert.equal(e[2].decision, 'block');
  e[0].phase = 'tampered'; e.length = 0;
  assert.equal(w.audit.entries().length, 4); assert.equal(w.audit.entries()[0].phase, 'decided');
});

test('T3.9 recovery: an allowed refund whose execution failed is pending; after a restart the retry pays once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salus-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const crm = createCrm();
  const w = world({ file, crm });
  crm.failNextRefund({ afterEffect: true });                  // the refund happened, but the process "crashed" before it knew
  const first = await w.call('issue_refund', R('ORD-1002', 4000));
  assert.equal(first.status, 'execution_failed');
  // The boundary cannot know whether the refund was applied, so it must not claim "not_executed".
  assert.deepEqual(w.audit.entries().map((e) => [e.phase, e.reason ?? e.decision]), [['decided', 'allow'], ['outcome_unknown', 'provider_error']]);
  assert.deepEqual(pendingActions(w.audit), ['refund:ORD-1002:4000:USD']);
  const restarted = world({ file, crm });                     // new process, same audit file, same CRM
  assert.deepEqual(pendingActions(restarted.audit), ['refund:ORD-1002:4000:USD']);
  const retry = await restarted.call('issue_refund', R('ORD-1002', 4000));
  assert.equal(retry.status, 'executed'); assert.equal(retry.replayed, true);
  assert.equal(crm.refunds().length, 1);
  assert.deepEqual(pendingActions(restarted.audit), []);
  assert.deepEqual(restarted.audit.entries().map((e) => e.phase), ['decided', 'outcome_unknown', 'decided', 'executed']);
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').every((l) => JSON.parse(l).phase));

  const crm2 = createCrm(); const w2 = world({ crm: crm2 });
  crm2.failNextRefund({ afterEffect: false });               // the CRM failed before paying
  assert.equal((await w2.call('issue_refund', R('ORD-1001', 500))).status, 'execution_failed');
  assert.equal(crm2.refunds().length, 0);
  assert.equal(w2.audit.entries().at(-1).phase, 'outcome_unknown', 'from the boundary, a provider error is an unknown outcome either way');
  assert.equal((await w2.call('issue_refund', R('ORD-1001', 500))).status, 'executed');
  assert.equal(crm2.refunds().length, 1);
});
