// T2.3: the same script against a fresh world always gives the same transcript (no LLM, no randomness, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrm } from '../crm/crm.ts';
import { runScriptedAgent } from './scripted.ts';
import { createFlawedTools } from '../integrations/flawed.ts';
import { createDecideClient } from '../decide/client.ts';
import { createMockSalus } from '../decide/mock.ts';

const KEY = 'sal_test_determinism_key';
const script = () => [
  { tool: 'lookup_order', args: { order_id: 'ORD-1002' } },
  { tool: 'issue_refund', args: { order_id: 'ORD-1002', amount_minor: 3000, currency: 'USD' } },
  { tool: 'issue_refund', args: { order_id: 'ORD-1002', amount_minor: 3000, currency: 'USD' } },
  { tool: 'issue_refund', args: { order_id: 'ORD-1003', amount_minor: 5000, currency: 'USD' }, tamper: (a) => { a.amount_minor = 60000; } },
  { tool: 'update_order', args: { order_id: 'ORD-1001', patch: { refunded_minor: 4500 } } },
  { tool: 'no_such_tool', args: {} },
];

async function run() {
  const crm = createCrm(); const mock = createMockSalus({ apiKey: KEY });
  const decide = createDecideClient({ baseUrl: 'https://app.usesalus.ai/v1', apiKey: KEY, fetch: mock.fetch, sleep: () => Promise.resolve(), maxAttempts: 1 });
  const { transcript } = await runScriptedAgent({ tools: createFlawedTools({ crm, decide }), script: script() });
  return { transcript, refunds: crm.refunds() };
}

test('the same script gives the same transcript', async () => {
  const a = await run(); const b = await run();
  assert.deepEqual(a, b);
  assert.equal(a.transcript.length, 6);
  assert.deepEqual(a.refunds.map((r) => r.amount_minor), [3000, 3000, 60000]);
});
