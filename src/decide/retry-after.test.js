// Retry-After handling on 429 (our local retry policy, contract item 5). Injected fetch only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecideClient } from './client.ts';

const KEY = 'sal_test_retry_after_key';
const req = { tool_name: 'issue_refund', idempotency_key: 'refund:ORD-1:100:USD', args: { order_id: 'ORD-1', amount_minor: 100 } };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(retryAfter) {
  const calls = [];
  const sleeps = [];
  const fetch = async (_url, init) => {
    calls.push(init.body);
    return calls.length === 1 ? json(429, { detail: 'rate limited' }, { 'retry-after': retryAfter }) : json(200, { decision: 'allow' });
  };
  const client = createDecideClient({ baseUrl: 'https://salus.invalid/v1', apiKey: KEY, fetch, maxAttempts: 3,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  return { client, calls, sleeps };
}

test('Retry-After in seconds within our limit is waited in full, then retried with the same body', async () => {
  const { client, calls, sleeps } = setup('30');
  const result = await client.decide(req);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(calls[0], calls[1]);
});

test('Retry-After above our 60s limit is never shortened: the 429 is returned without retrying', async () => {
  const { client, calls, sleeps } = setup('120');
  const result = await client.decide(req);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { kind: 'http', status: 429, detail: 'rate limited' });
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('Retry-After as a near-future HTTP date is waited until that date', async () => {
  const { client, sleeps } = setup(new Date(Date.now() + 20_000).toUTCString());
  const result = await client.decide(req);
  assert.equal(result.ok, true);
  assert.equal(sleeps.length, 1);
  // toUTCString drops milliseconds, so allow up to ~1s plus test run time below the requested 20s.
  assert.ok(sleeps[0] > 17_000 && sleeps[0] <= 20_000, `slept ${sleeps[0]}`);
});

test('Retry-After as an HTTP date beyond our limit is not retried', async () => {
  const { client, calls, sleeps } = setup(new Date(Date.now() + 300_000).toUTCString());
  const result = await client.decide(req);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 429);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});
