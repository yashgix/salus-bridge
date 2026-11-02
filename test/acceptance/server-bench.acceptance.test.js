// Acceptance tests: the contract for the MCP-style stdio server, the reproducible benchmark and the README.
//   src/mcp/server.ts  `node src/mcp/server.ts`: newline-delimited JSON-RPC 2.0 on stdin/stdout ("MCP-style"; no claim
//                      of MCP compatibility). Methods: initialize -> { serverInfo: { name: "salus-bridge", version },
//                      capabilities: { tools: {} } }; tools/list -> { tools: [{ name, description, inputSchema }] } with
//                      exactly issue_refund and lookup_order (the protected boundary); tools/call { name, arguments } ->
//                      { content: [{ type: "text", text: <JSON of the tool result> }], isError? }. Unknown method:
//                      error -32601; unparsable line: error -32700 with id null. Exits when stdin closes.
//                      Offline by default: a seeded CRM and the local mock (SALUS_BRIDGE_MODE unset or "mock").
//   bench/run.ts       `node bench/run.ts --seed N --runs M` prints one JSON object to stdout:
//                      { seed, runs, environment: { node, mock: true },
//                        scenarios: [{ id, integration: "flawed"|"protected", invariant_held: boolean }],
//                        summary: { flawed: { held, violated }, protected: { held, violated } },
//                        latency_ms: { decide_p50, decide_p95, boundary_p50, boundary_p95 } }
//                      Correctness output is identical for the same seed; latency is measured against the local mock.
//   README.md          how to run, what the results mean, and the independent/unofficial label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const NODE = process.execPath;
const SCENARIOS = ['allow_small_refund', 'escalate_medium_refund', 'block_large_refund', 'bypass_alternate_write',
  'args_tampered_after_decision', 'fail_open_on_timeout', 'malformed_response', 'duplicate_retry', 'concurrent_duplicate', 'crash_recovery'];

function server() {
  const env = { ...process.env }; delete env.SALUS_BRIDGE_MODE; delete env.SALUS_API_KEY;
  const p = spawn(NODE, ['src/mcp/server.ts'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const killer = setTimeout(() => p.kill('SIGKILL'), 20000); p.on('exit', () => clearTimeout(killer));   // hard stop
  let buf = ''; const waiting = []; const lines = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { lines.push(JSON.parse(l)); waiting.shift()?.(); } } });
  const next = () => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no reply')), 5000);
    const take = () => { clearTimeout(t); res(lines.shift()); };
    lines.length ? take() : waiting.push(take);
  });
  const send = (o) => { p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n'); return next(); };
  return { p, send };
}

test('T4.1 MCP-style server: initialize, tools/list (protected tools only), tools/call, errors, exit on stdin close', async (t) => {
  const s = server();
  t.after(() => { if (s.p.exitCode === null && s.p.signalCode === null) s.p.kill('SIGKILL'); });   // never leave it running
  const init = await s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.jsonrpc, '2.0'); assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'salus-bridge'); assert.ok(init.result.capabilities.tools);
  const list = await s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['issue_refund', 'lookup_order']);
  for (const t of list.result.tools) { assert.equal(typeof t.description, 'string'); assert.equal(t.inputSchema.type, 'object'); }
  const ok = await s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'issue_refund', arguments: { order_id: 'ORD-1001', amount_minor: 1000, currency: 'USD' } } });
  assert.equal(ok.id, 3); assert.equal(ok.result.content[0].type, 'text');
  assert.equal(JSON.parse(ok.result.content[0].text).status, 'executed');
  const blocked = await s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'issue_refund', arguments: { order_id: 'ORD-1003', amount_minor: 60000, currency: 'USD' } } });
  const b = JSON.parse(blocked.result.content[0].text);
  assert.equal(b.status, 'action_not_executed'); assert.equal(b.decision, 'block');
  const look = await s.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lookup_order', arguments: { order_id: 'ORD-1001' } } });
  assert.match(look.result.content[0].text, /ORD-1001/);
  const bypass = await s.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'update_order', arguments: { order_id: 'ORD-1003', patch: {} } } });
  assert.ok(bypass.error || bypass.result.isError === true, 'unknown tool is an error');
  assert.equal((await s.send({ jsonrpc: '2.0', id: 7, method: 'nope' })).error.code, -32601);
  const parse = await s.send('{not json');
  assert.equal(parse.error.code, -32700); assert.equal(parse.id, null);
  const exited = new Promise((res) => s.p.on('exit', (code) => res(code)));
  s.p.stdin.end();
  assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]), 0);
});

test('T4.2 bench: every scenario on both integrations, protected never violates, flawed shows the flaws, same seed same result', () => {
  const run = () => {
    const r = spawnSync(NODE, ['bench/run.ts', '--seed', '7', '--runs', '30'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const a = run(), b = run();
  assert.equal(a.seed, 7); assert.equal(a.runs, 30); assert.equal(a.environment.mock, true);
  for (const id of SCENARIOS) for (const integration of ['flawed', 'protected']) {
    assert.equal(a.scenarios.filter((s) => s.id === id && s.integration === integration).length, 1, `${id}/${integration}`);
  }
  assert.ok(a.scenarios.filter((s) => s.integration === 'protected').every((s) => s.invariant_held === true));
  const flawedBad = a.scenarios.filter((s) => s.integration === 'flawed' && !s.invariant_held).map((s) => s.id).sort();
  for (const id of ['args_tampered_after_decision', 'bypass_alternate_write', 'duplicate_retry', 'fail_open_on_timeout']) assert.ok(flawedBad.includes(id), id);
  assert.deepEqual(a.summary.protected, { held: a.scenarios.filter((s) => s.integration === 'protected').length, violated: 0 });
  assert.equal(a.summary.flawed.violated, flawedBad.length);
  assert.deepEqual(a.scenarios, b.scenarios, 'correctness results are reproducible for a seed');
  for (const k of ['decide_p50', 'decide_p95', 'boundary_p50', 'boundary_p95']) {
    assert.ok(Number.isFinite(a.latency_ms[k]) && a.latency_ms[k] >= 0, k);
  }
  assert.ok(a.latency_ms.decide_p95 >= a.latency_ms.decide_p50 && a.latency_ms.boundary_p95 >= a.latency_ms.boundary_p50);
});

test('T4.3 README: how to run, results, and the independent, unofficial label', () => {
  const r = fs.readFileSync('README.md', 'utf8');
  assert.match(r, /independent/i); assert.match(r, /unofficial/i); assert.match(r, /not affiliated/i);
  assert.match(r, /\/v1\/decide/); assert.match(r, /node --test/); assert.match(r, /node bench\/run\.ts/); assert.match(r, /node src\/mcp\/server\.ts/);
  assert.match(r, /mock/i);
  assert.match(r, /docs\/decide-contract\.md/);
});
