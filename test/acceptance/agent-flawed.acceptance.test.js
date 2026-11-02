// Acceptance tests: the contract for the synthetic CRM, the scripted tool-calling agent, and the
// DELIBERATELY FLAWED integration. These tests assert that the flaws are present: the flawed example exists to show
// what goes wrong. Interfaces required by these tests:
//   src/crm/crm.ts       export function createCrm() -> seeded synthetic orders (below) and
//                        getOrder(id) -> { order_id, customer_id, amount_minor, currency, refunded_minor } | undefined (a copy)
//                        refund({ order_id, amount_minor, currency, idempotency_key })
//                          -> { ok: true, refund_id, order_id, amount_minor, currency, replayed }
//                           | { ok: false, error: "not_found"|"invalid_amount"|"currency_mismatch"|"exceeds_remaining"|"idempotency_conflict" }
//                        updateOrder(order_id, patch) -> { ok, order? }   (an admin write path: the "alternate path")
//                        refunds() -> executed refunds (copies), in order;  failNextRefund({ afterEffect }) -> next refund()
//                        throws; with afterEffect: true the refund is applied first, then it throws (outcome unknown)
//   src/agent/scripted.ts export async function runScriptedAgent({ tools, script }) -> { transcript: [{ tool, args, result }] }
//                        tools: [{ name, description, inputSchema, call(args) }]; script: [{ tool, args, tamper? }];
//                        the agent passes `args` itself (same object) to call(), then runs tamper(args) right away,
//                        before the call settles (an agent changing its arguments after the decision was requested).
//                        Unknown tool -> result { status: "error", error: "unknown_tool" }. Steps run in order.
//   src/integrations/flawed.ts export function createFlawedTools({ crm, decide }) -> tools named lookup_order,
//                        issue_refund, update_order. `decide` is a client from src/decide/client.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrm } from '../../src/crm/crm.ts';
import { runScriptedAgent } from '../../src/agent/scripted.ts';
import { createFlawedTools } from '../../src/integrations/flawed.ts';
import { createDecideClient } from '../../src/decide/client.ts';
import { createMockSalus } from '../../src/decide/mock.ts';

const KEY = 'sal_test_acceptance_key';
function world() {
  const crm = createCrm(); const mock = createMockSalus({ apiKey: KEY });
  const decide = createDecideClient({ baseUrl: 'https://app.usesalus.ai/v1', apiKey: KEY, fetch: mock.fetch, sleep: () => Promise.resolve(), timeoutMs: 30, maxAttempts: 1 });
  return { crm, mock, decide, tools: createFlawedTools({ crm, decide }) };
}

test('T2.1 CRM: seeded synthetic orders and safe refund rules', () => {
  const crm = createCrm();
  assert.deepEqual(crm.getOrder('ORD-1001'), { order_id: 'ORD-1001', customer_id: 'C-1', amount_minor: 4500, currency: 'USD', refunded_minor: 0 });
  assert.equal(crm.getOrder('ORD-1002').amount_minor, 25000);
  assert.equal(crm.getOrder('ORD-1003').amount_minor, 90000);
  assert.equal(crm.getOrder('ORD-1004').currency, 'EUR');
  assert.equal(crm.getOrder('ORD-9999'), undefined);
  const o = crm.getOrder('ORD-1001'); o.refunded_minor = 1;
  assert.equal(crm.getOrder('ORD-1001').refunded_minor, 0, 'getOrder returns a copy');
  const ok = crm.refund({ order_id: 'ORD-1001', amount_minor: 1000, currency: 'USD', idempotency_key: 'k1' });
  assert.equal(ok.ok, true); assert.equal(ok.replayed, false); assert.equal(typeof ok.refund_id, 'string');
  assert.equal(crm.getOrder('ORD-1001').refunded_minor, 1000);
  const again = crm.refund({ order_id: 'ORD-1001', amount_minor: 1000, currency: 'USD', idempotency_key: 'k1' });
  assert.equal(again.ok, true); assert.equal(again.replayed, true); assert.equal(again.refund_id, ok.refund_id);
  assert.equal(crm.refunds().length, 1);
  assert.equal(crm.refund({ order_id: 'ORD-1001', amount_minor: 999, currency: 'USD', idempotency_key: 'k1' }).error, 'idempotency_conflict');
  assert.equal(crm.refund({ order_id: 'ORD-1001', amount_minor: 4000, currency: 'USD', idempotency_key: 'k2' }).error, 'exceeds_remaining');
  assert.equal(crm.refund({ order_id: 'ORD-1001', amount_minor: 100, currency: 'EUR', idempotency_key: 'k3' }).error, 'currency_mismatch');
  assert.equal(crm.refund({ order_id: 'ORD-1001', amount_minor: 0, currency: 'USD', idempotency_key: 'k4' }).error, 'invalid_amount');
  assert.equal(crm.refund({ order_id: 'ORD-1001', amount_minor: 1.5, currency: 'USD', idempotency_key: 'k5' }).error, 'invalid_amount');
  assert.equal(crm.refund({ order_id: 'ORD-9999', amount_minor: 100, currency: 'USD', idempotency_key: 'k6' }).error, 'not_found');
  assert.equal(crm.refunds().length, 1);
  crm.failNextRefund({ afterEffect: true });
  assert.throws(() => crm.refund({ order_id: 'ORD-1002', amount_minor: 100, currency: 'USD', idempotency_key: 'k7' }));
  assert.equal(crm.refunds().length, 2, 'afterEffect: applied, then threw');
  crm.failNextRefund({ afterEffect: false });
  assert.throws(() => crm.refund({ order_id: 'ORD-1002', amount_minor: 100, currency: 'USD', idempotency_key: 'k8' }));
  assert.equal(crm.refunds().length, 2);
});

test('T2.2 scripted agent: runs steps in order through tool definitions; unknown tools are reported, not run', async () => {
  const seen = [];
  const tools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, call: async (a) => { seen.push(a.n); return { status: 'ok', n: a.n }; } }];
  const out = await runScriptedAgent({ tools, script: [{ tool: 'echo', args: { n: 1 } }, { tool: 'nope', args: {} }, { tool: 'echo', args: { n: 2 } }] });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(out.transcript.length, 3);
  assert.deepEqual(out.transcript[0].result, { status: 'ok', n: 1 });
  assert.deepEqual(out.transcript[1].result, { status: 'error', error: 'unknown_tool' });
  let order = [];
  const slow = [{ name: 's', description: 's', inputSchema: { type: 'object' }, call: async (a) => { order.push('call:' + a.v); await new Promise((r) => setTimeout(r, 5)); order.push('done:' + a.v); return {}; } }];
  await runScriptedAgent({ tools: slow, script: [{ tool: 's', args: { v: 1 }, tamper: (a) => { order.push('tamper:' + a.v); a.v = 9; } }] });
  assert.deepEqual(order, ['call:1', 'tamper:1', 'done:9'], 'tamper runs after the call starts and before it settles, on the same object');
});

test('T2.3 flawed: exposes lookup_order, issue_refund and update_order as MCP-style tool definitions', () => {
  const { tools } = world();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['issue_refund', 'lookup_order', 'update_order']);
  for (const t of tools) { assert.equal(typeof t.description, 'string'); assert.equal(t.inputSchema.type, 'object'); }
});

test('T2.4 flawed: a small refund is decided and executed (the happy path works)', async () => {
  const w = world();
  const out = await runScriptedAgent({ tools: w.tools, script: [{ tool: 'issue_refund', args: { order_id: 'ORD-1001', amount_minor: 1000, currency: 'USD' } }] });
  assert.equal(w.mock.requests.length, 1);
  assert.equal(w.crm.refunds().length, 1);
  assert.equal(out.transcript[0].result.status, 'executed');
});

test('T2.5 FLAW alternate write path: update_order changes refunded_minor with no Salus decision', async () => {
  const w = world();
  await runScriptedAgent({ tools: w.tools, script: [{ tool: 'update_order', args: { order_id: 'ORD-1003', patch: { refunded_minor: 90000 } } }] });
  assert.equal(w.crm.getOrder('ORD-1003').refunded_minor, 90000);
  assert.equal(w.mock.requests.length, 0);
});

test('T2.6 FLAW changed arguments: the refund executes the tampered amount, not the one Salus decided on', async () => {
  const w = world();
  await runScriptedAgent({ tools: w.tools, script: [{ tool: 'issue_refund', args: { order_id: 'ORD-1003', amount_minor: 5000, currency: 'USD' },
    tamper: (a) => { a.amount_minor = 60000; } }] });
  assert.equal(w.mock.requests[0].args.amount_minor, 5000, 'Salus saw 5000 (allow)');
  assert.equal(w.crm.refunds()[0].amount_minor, 60000, 'the CRM paid 60000, which the policy blocks');
});

test('T2.7 FLAW fail-open: when Salus times out, the flawed integration refunds anyway', async () => {
  const w = world();
  w.mock.failNext('timeout');
  await runScriptedAgent({ tools: w.tools, script: [{ tool: 'issue_refund', args: { order_id: 'ORD-1002', amount_minor: 20000, currency: 'USD' } }] });
  assert.equal(w.crm.refunds().length, 1);
});

test('T2.8 FLAW duplicate on retry: the same refund requested twice is paid twice', async () => {
  const w = world();
  const step = { tool: 'issue_refund', args: { order_id: 'ORD-1002', amount_minor: 3000, currency: 'USD' } };
  await runScriptedAgent({ tools: w.tools, script: [step, { ...step, args: { ...step.args } }] });
  assert.equal(w.crm.refunds().length, 2);
  assert.equal(w.crm.getOrder('ORD-1002').refunded_minor, 6000);
});
