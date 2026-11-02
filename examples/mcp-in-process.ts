// `node examples/mcp-in-process.ts`: drives the MCP-style JSON-RPC handler (the one behind src/mcp/server.ts)
// in-process, line by line, exactly as the stdio server would. Offline, no sockets, no file writes.
// Independent, unofficial code; not affiliated with or endorsed by Salus.

import { createMcpHandler } from "../src/mcp/handler.ts";

const handler = createMcpHandler();
const lines = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_refund", arguments: { order_id: "ORD-1001", amount_minor: 1000, currency: "USD" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "issue_refund", arguments: { order_id: "ORD-1002", amount_minor: 20000, currency: "USD" } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "update_order", arguments: { order_id: "ORD-1003", patch: {} } } },
];

for (const message of lines) {
  console.log("->", JSON.stringify(message));
  console.log("<-", await handler.handleLine(JSON.stringify(message)));
}
console.log("audit:", handler.audit.entries().map((e) => `${e.phase}:${e.idempotency_key}`).join(", "));
