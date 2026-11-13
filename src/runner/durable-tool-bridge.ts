/**
 * durable-tool-bridge.ts — Adapts Pi and MCP tools to @earendil-works/pi-durable ToolRegistration.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/** Set of tools that are idempotent and safe to rerun if interrupted by process restart. */
const REPLAY_SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "get_subagent_result",
]);

export interface BridgeToolOptions {
  beforeToolCall?: (context: any, signal?: AbortSignal) => Promise<any> | any;
  afterToolCall?: (context: any, signal?: AbortSignal) => Promise<any> | any;
  onToolStart?: (info: { toolName: string; toolCallId: string; args: any }) => void;
  onToolUpdate?: (info: { toolName: string; toolCallId: string; args: any; partialResult: any }) => void;
  onToolResult?: (result: any) => void;
  signal?: AbortSignal;
  toolContext?: unknown | ((callId: string) => unknown);
}

export interface ExecutablePiTool {
  name: string;
  description?: string;
  parameters: object;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (partial: any) => void,
    ctx?: any,
  ) => Promise<AgentToolResult<any>>;
}

/**
 * Adapt a Pi extension tool, MCP tool, or nested subagent tool into a durable ToolRegistration.
 */
export function bridgePiToolToDurableTool(
  tool: ExecutablePiTool,
  options: BridgeToolOptions = {},
): ToolRegistration {
  const isSafe = REPLAY_SAFE_TOOLS.has(tool.name);

  return defineTool({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    replay: isSafe ? "safe" : "unsafe",
    prepareArguments: tool.prepareArguments
      ? (args: unknown) => tool.prepareArguments!(args) as object
      : undefined,
    async execute(args: any, api, _chordCtx: Context) {
      const callId = (api as any)?.callId ?? `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (options.beforeToolCall) {
        const decision = await options.beforeToolCall(
          { toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: args }, args },
          options.signal,
        );
        if (decision?.block) {
          throw new Error(decision.reason ?? `Tool call blocked: ${tool.name}`);
        }
      }
      if (options.signal?.aborted) {
        throw new Error("Aborted");
      }

      options.onToolStart?.({
        toolName: tool.name,
        toolCallId: callId,
        args,
      });

      let result: AgentToolResult<JsonValue | undefined>;
      try {
        const updateCallback = (partial: any) => {
          if (!partial) return;
          options.onToolUpdate?.({
            toolName: tool.name,
            toolCallId: callId,
            args,
            partialResult: partial,
          });
          if (typeof partial === "string") {
            api.output(partial);
          } else if (typeof partial === "object") {
            if (typeof partial.content === "string") {
              api.output(partial.content);
            } else if (Array.isArray(partial.content)) {
              for (const part of partial.content) {
                if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                  api.output(part.text);
                }
              }
            }
          }
        };

        const effectiveToolContext =
          typeof options.toolContext === "function"
            ? (options.toolContext as (id: string) => unknown)(callId)
            : options.toolContext;

        result = await tool.execute(
          callId,
          args,
          options.signal,
          updateCallback,
          effectiveToolContext,
        );
      } catch (err: unknown) {
        result = {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          details: {},
          isError: true,
        };
      }

      // Legacy tool shapes returned `output`/string `content`; keep reading them.
      const rawResult = result as unknown as { content?: unknown; output?: unknown };
      const output: ToolResultMessage["content"] = Array.isArray(rawResult.content)
        ? (rawResult.content as ToolResultMessage["content"])
        : typeof rawResult.content === "string"
          ? [{ type: "text" as const, text: rawResult.content }]
          : typeof rawResult.output === "string"
            ? [{ type: "text" as const, text: rawResult.output }]
            : Array.isArray(rawResult.output)
              ? (rawResult.output as ToolResultMessage["content"])
              : [];

      let finalOutput = output;
      let finalDetails = result?.details;
      let finalIsError = result?.isError === true;
      let finalUsage = result?.usage;
      try {
        if (options.afterToolCall) {
          const hookResult = await options.afterToolCall(
            {
              toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: args },
              args,
              result: { content: output, details: result?.details, usage: result?.usage },
              isError: finalIsError,
            },
            options.signal,
          );
          finalOutput = hookResult?.content ?? finalOutput;
          finalDetails = hookResult?.details ?? finalDetails;
          finalIsError = hookResult?.isError ?? finalIsError;
          finalUsage = hookResult?.usage ?? finalUsage;
        }
      } catch (err: unknown) {
        finalOutput = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
        finalDetails = {};
        finalIsError = true;
        finalUsage = undefined;
      }

      options.onToolResult?.({
        role: "toolResult",
        toolName: tool.name,
        toolCallId: callId,
        content: finalOutput,
        details: finalDetails,
        isError: finalIsError,
        usage: finalUsage,
        timestamp: Date.now(),
      });

      return {
        output: finalOutput,
        isError: finalIsError,
        details: finalDetails as JsonValue,
        usage: finalUsage,
      };
    },
  });
}
