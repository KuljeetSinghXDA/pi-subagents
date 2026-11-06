/**
 * durable-runner.ts — Execution engine backed by @earendil-works/pi-durable.
 *
 * Provides transactional, crash-resilient subagent runs with native task ownership,
 * dependency waiting, and replay-safe execution.
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  createRegistry,
  Harness,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { getAgentConfig } from "../agent-types.js";
import { detectEnv } from "../env.js";
import { buildAgentPrompt, inheritableParentPrompt } from "../prompts.js";
import type { SubagentType } from "../types.js";
import type { RunOptions, RunResult } from "./runner-types.js";

export interface DurableRunOptions extends RunOptions {
  storage?: Storage;
}

/**
 * Run a subagent using the @earendil-works/pi-durable harness.
 * Replaces manual session file healing and shadow sessions with native durable commits.
 */
export async function runDurableAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string | undefined,
  options: DurableRunOptions,
): Promise<RunResult> {
  const agentConfig = getAgentConfig(type);
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const storage = options.storage ?? new MemoryStorage();

  const models = createModels();
  // Transfer authenticated providers from context modelRegistry if present
  if (ctx.modelRegistry) {
    const parentRuntime = (ctx.modelRegistry as unknown as { runtime?: { models?: unknown } }).runtime;
    if (parentRuntime && (parentRuntime as any).models) {
      // Re-use models instance if accessible
      Object.assign(models, (parentRuntime as any).models);
    }
  }

  const baseContext = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  const registry = createRegistry();

  const harness = await Harness.open(storage, { models, registry }, baseContext);

  const env = await detectEnv(options.pi, effectiveCwd);
  const parentSystemPrompt = inheritableParentPrompt(ctx.getSystemPrompt(), ctx.cwd);
  const systemPrompt = agentConfig
    ? buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, {})
    : "You are an autonomous subagent.";

  const modelRef = options.model
    ? { provider: options.model.provider, modelId: options.model.id }
    : ctx.model
      ? { provider: ctx.model.provider, modelId: ctx.model.id }
      : undefined;

  let conversation: Conversation;
  try {
    conversation = await harness.root(baseContext, {
      agent: {
        model: modelRef,
        thinkingLevel: (options.thinkingLevel as any) ?? undefined,
        instructions: systemPrompt,
        maxTurns: options.maxTurns,
      },
    });

    if (prompt === undefined) {
      // Bare continuation
      await conversation.waitForIdle(baseContext);
    } else {
      const submission = await conversation.submit({ type: "input", content: prompt }, baseContext);
      await submission.wait(baseContext);
    }

    const contextView = await conversation.context(baseContext);
    const messages = contextView.messages;

    let responseText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && (part as any).type === "text") {
            responseText = (part as any).text;
            break;
          }
        }
        if (responseText) break;
      }
    }

    const trimmed = responseText.trim();
    if (trimmed && options.onTextDelta) {
      options.onTextDelta(trimmed, trimmed);
    }

    const sessionObj = {
      messages: [...messages],
      getActiveToolNames: () => [],
    } as any;
    options.onSessionCreated?.(sessionObj);

    return {
      responseText: trimmed,
      session: sessionObj,
      aborted: options.signal?.aborted === true,
      steered: false,
    };
  } finally {
    try {
      await harness.close(baseContext);
    } catch {
      // best-effort cleanup
    }
  }
}
