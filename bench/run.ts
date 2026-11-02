// `node bench/run.ts --seed N --runs M`: runs every scenario M times against the flawed and the protected
// integrations (scripted agent, synthetic CRM, local mock Salus) and prints one JSON object to stdout.
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// Correctness (`scenarios`, `summary`) depends only on the seed. `latency_ms` is wall-clock time measured against the
// LOCAL IN-PROCESS MOCK only (no network); it is not, and must not be read as, real Salus latency.

import { requireMockMode } from "../src/mcp/mode.ts";
import { createPrng, runScenario, SCENARIO_IDS, type Integration, type Timings } from "./scenarios.ts";

requireMockMode();

function intArg(name: string, fallback: number, min: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isSafeInteger(value) || value < min) {
    process.stderr.write(`bench: --${name} must be an integer >= ${min}\n`);
    process.exit(2);
  }
  return value;
}

// Nearest-rank percentile, rounded to microseconds.
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
  return Math.round(value * 1000) / 1000;
}

const seed = intArg("seed", 1, 0);
const runs = intArg("runs", 20, 1);
const integrations: Integration[] = ["flawed", "protected"];
const timings: Timings = { decide: [], boundary: [] };

const scenarios: { id: string; integration: Integration; invariant_held: boolean; runs_violated: number }[] = [];
for (const [index, id] of SCENARIO_IDS.entries()) {
  for (const integration of integrations) {
    let violated = 0;
    for (let r = 0; r < runs; r += 1) {
      // Same seed, scenario and run -> same inputs for both integrations, so they are compared like for like.
      const rng = createPrng((seed * 1_000_003 + index * 10_007 + r) >>> 0);
      // Latency is only sampled on the protected boundary (the one worth measuring).
      const held = await runScenario(id, integration, rng, integration === "protected" ? timings : undefined);
      if (!held) violated += 1;
    }
    scenarios.push({ id, integration, invariant_held: violated === 0, runs_violated: violated });
  }
}

const tally = (integration: Integration) => {
  const own = scenarios.filter((s) => s.integration === integration);
  const held = own.filter((s) => s.invariant_held).length;
  return { held, violated: own.length - held };
};

const report = {
  seed,
  runs,
  environment: {
    node: process.version,
    mock: true,
    note: "Offline. Decisions come from the local in-process mock of /v1/decide (src/decide/mock.ts); no network, no Salus key.",
  },
  scenarios,
  summary: { flawed: tally("flawed"), protected: tally("protected") },
  latency_ms: {
    measured_against: "local in-process mock only; not real Salus latency",
    samples: { decide: timings.decide.length, boundary: timings.boundary.length },
    decide_p50: percentile(timings.decide, 50),
    decide_p95: percentile(timings.decide, 95),
    boundary_p50: percentile(timings.boundary, 50),
    boundary_p95: percentile(timings.boundary, 95),
  },
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
