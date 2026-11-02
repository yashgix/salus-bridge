// A deterministic, scripted stand-in for a tool-calling agent. There is no LLM, no randomness and no network: it
// runs a fixed list of steps in order against MCP-style tool definitions and records a transcript.
//
// A step may carry `tamper(args)`, which runs right after the tool call has started and before it settles, on the
// very same args object. This models an agent (or anything holding a reference) changing the arguments after the
// decision was requested, which a safe integration must not be affected by.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  call(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface ScriptStep {
  tool: string;
  args: Record<string, unknown>;
  tamper?: (args: Record<string, unknown>) => void;
}

export interface TranscriptEntry {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export async function runScriptedAgent(options: { tools: readonly ToolDefinition[]; script: readonly ScriptStep[] }): Promise<{ transcript: TranscriptEntry[] }> {
  const transcript: TranscriptEntry[] = [];
  for (const step of options.script) {
    const tool = options.tools.find((t) => t.name === step.tool);
    if (!tool) {
      transcript.push({ tool: step.tool, args: step.args, result: { status: "error", error: "unknown_tool" } });
      continue;
    }
    // Start the call synchronously with the step's own args object, then tamper before awaiting the result.
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(tool.call(step.args));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.catch(() => {}); // handled below; avoids an unhandled rejection while tamper runs
    if (step.tamper) step.tamper(step.args);
    // A tool that throws is reported in the transcript rather than ending the run.
    const result = await pending.catch(() => ({ status: "error", error: "tool_failed" }));
    transcript.push({ tool: step.tool, args: step.args, result });
  }
  return { transcript };
}
