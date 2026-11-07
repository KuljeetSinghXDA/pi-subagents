/**
 * durable-tool-bridge.ts — Adapts Pi and MCP tools to @earendil-works/pi-durable ToolRegistration.
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolActivity } from "./runner-types.js";

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
  onActivity?: (activity: ToolActivity) => void;
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

      options.onActivity?.({
        type: "start",
        toolName: tool.name,
        toolCallId: callId,
        args,
      });
      options.onToolStart?.({
        toolName: tool.name,
        toolCallId: callId,
        args,
      });

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

        const result = await tool.execute(
          callId,
          args,
          options.signal,
          updateCallback,
          effectiveToolContext,
        );

        options.onActivity?.({
          type: "end",
          toolName: tool.name,
          toolCallId: callId,
        });

        const output: ToolResultMessage["content"] = Array.isArray(result?.content)
          ? (result.content as ToolResultMessage["content"])
          : typeof result?.content === "string"
            ? [{ type: "text" as const, text: result.content }]
            : typeof (result as any)?.output === "string"
              ? [{ type: "text" as const, text: (result as any).output }]
              : Array.isArray((result as any)?.output)
                ? (result as any).output
                : [];

        let finalOutput = output;
        if (options.afterToolCall) {
          const hookResult = await options.afterToolCall(
            {
              toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: args },
              args,
              result: { content: output, details: result?.details },
              isError: result?.isError === true,
            },
            options.signal,
          );
          if (hookResult?.content) {
            finalOutput = hookResult.content;
          }
        }

        options.onToolResult?.({
          role: "toolResult",
          toolName: tool.name,
          toolCallId: callId,
          content: finalOutput,
          details: result?.details,
          isError: result?.isError === true,
          timestamp: Date.now(),
        });

        return {
          output: finalOutput,
          isError: result?.isError === true,
          details: result?.details as JsonValue,
        };
      } catch (err: unknown) {
        options.onActivity?.({
          type: "end",
          toolName: tool.name,
          toolCallId: callId,
        });

        const errorMsg = err instanceof Error ? err.message : String(err);
        options.onToolResult?.({
          role: "toolResult",
          toolName: tool.name,
          toolCallId: callId,
          content: [{ type: "text" as const, text: errorMsg }],
          isError: true,
          timestamp: Date.now(),
        });

        return {
          output: [{ type: "text" as const, text: errorMsg }],
          isError: true,
        };
      }
    },
  });
}
