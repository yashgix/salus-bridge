// The JSON-RPC 2.0 request handler behind src/mcp/server.ts, kept free of stdio so it can be driven in-process.
// "MCP-style": it uses the initialize / tools/list / tools/call method names and result shapes, but makes no claim of
// MCP compatibility (no protocol version negotiation, no other MCP methods).
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// Only the protected boundary (src/integrations/protected.ts) is exposed: issue_refund and lookup_order. There is no
// update_order, so an MCP-style client has no unprotected path to the refund side effect.

import { createCrm, type Crm } from "../crm/crm.ts";
import { createDecideClient } from "../decide/client.ts";
import { createMockSalus } from "../decide/mock.ts";
import { createAuditLog, type AuditLog } from "../integrations/audit.ts";
import { createProtectedTools } from "../integrations/protected.ts";
import type { ToolDefinition } from "../agent/scripted.ts";
import { MOCK_API_KEY, MOCK_BASE_URL } from "./mode.ts";

export const SERVER_INFO = { name: "salus-bridge", version: "0.1.0" } as const;

type Id = string | number | null;

interface RpcError { code: number; message: string }

export interface McpHandler {
  // Handles one input line. Returns the response line, or undefined for a notification (no reply).
  handleLine(line: string): Promise<string | undefined>;
  readonly crm: Crm;
  readonly audit: AuditLog;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

// Offline by default: the synthetic CRM, the local mock (through an injected fetch) and an in-memory audit log.
export function createMcpHandler(options: { tools?: readonly ToolDefinition[] } = {}): McpHandler {
  const crm = createCrm();
  const audit = createAuditLog();
  const mock = createMockSalus({ apiKey: MOCK_API_KEY });
  const decide = createDecideClient({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY, fetch: mock.fetch });
  const tools = options.tools ?? createProtectedTools({ crm, decide, audit });

  const reply = (id: Id, result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id, result });
  const fail = (id: Id, error: RpcError): string => JSON.stringify({ jsonrpc: "2.0", id, error });

  async function callTool(params: unknown): Promise<{ result?: unknown; error?: RpcError }> {
    if (!isObject(params) || typeof params.name !== "string") return { error: { code: -32602, message: "Invalid params: name is required" } };
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) return { error: { code: -32602, message: "Invalid params: arguments must be an object" } };
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) {
      return { result: { content: [{ type: "text", text: JSON.stringify({ status: "error", error: "unknown_tool" }) }], isError: true } };
    }
    let out: unknown;
    try {
      out = await tool.call(args);
    } catch {
      out = { status: "error", error: "tool_failed" };
    }
    const status = isObject(out) ? out.status : undefined;
    const isError = status === "error" || status === "rejected" || status === "execution_failed";
    return { result: { content: [{ type: "text", text: JSON.stringify(out) }], ...(isError ? { isError: true } : {}) } };
  }

  async function handleLine(line: string): Promise<string | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, { code: -32700, message: "Parse error" });
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
        (message.id !== undefined && !isId(message.id))) {
      return fail(isObject(message) && isId(message.id) ? message.id : null, { code: -32600, message: "Invalid Request" });
    }
    const notification = message.id === undefined;
    const id: Id = notification ? null : (message.id as Id);

    let outcome: { result?: unknown; error?: RpcError };
    switch (message.method) {
      case "initialize":
        outcome = { result: { serverInfo: { ...SERVER_INFO }, capabilities: { tools: {} } } };
        break;
      case "tools/list":
        outcome = { result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
        break;
      case "tools/call":
        outcome = await callTool(message.params);
        break;
      default:
        outcome = { error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
    if (notification) return undefined;
    return outcome.error ? fail(id, outcome.error) : reply(id, outcome.result);
  }

  return { handleLine, crm, audit };
}
