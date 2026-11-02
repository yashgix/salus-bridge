// `node src/mcp/server.ts`: an MCP-style server speaking newline-delimited JSON-RPC 2.0 on stdin/stdout.
// "MCP-style" only; no claim of MCP compatibility. Offline: seeded synthetic CRM, local mock Salus, in-memory audit.
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// SALUS_BRIDGE_MODE must be unset or "mock"; anything else exits non-zero before anything is created (src/mcp/mode.ts).
// Requests are handled one at a time, in order, so responses come back in request order. Exits 0 when stdin closes.

import { createInterface } from "node:readline";
import { requireMockMode } from "./mode.ts";
import { createMcpHandler } from "./handler.ts";

requireMockMode();

const handler = createMcpHandler();
let queue: Promise<void> = Promise.resolve();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue.then(async () => {
    const out = await handler.handleLine(line);
    if (out !== undefined) process.stdout.write(out + "\n");
  });
});
rl.on("close", () => {
  void queue.then(() => process.stdout.write("", () => process.exit(0)));
});
