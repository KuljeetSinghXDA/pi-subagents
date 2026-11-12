import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isTopLevelAgent } from "../agent-manager.js";
import { findAgentRecordEntry, formatSavedAgentRecord } from "../agent-record-entry.js";
import { getAgentConversation, SUBAGENT_TOOL_NAMES, steerAgent } from "../agent-runner.js";
import type { CompletionOutbox } from "../completion-outbox.js";
import { formatLifetimeTokens, markdownText, textResult } from "../entry/renderers.js";
import { consumeTerminalResult, waitForRecord } from "../manager/wait-for-record.js";
import { formatAnswerSteer, getStatusNote, openQuestionsFooter, partialOutputSuffix } from "../status-note.js";
import type { AgentRecord, MentionResolution } from "../types.js";
import { formatCost, formatDuration, getDisplayName } from "../ui/agent-widget.js";
import { getLifetimeCost, getSessionContextPercent, type PendingUsagePool } from "../usage.js";

export interface InspectToolsDeps {
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
  /** `@handle` resolution including tombstones, for the saved-record fallback. */
  resolveMention: (name: string) => MentionResolution | undefined;
  isShowCostEnabled: () => boolean;
  outbox: CompletionOutbox;
  pi: ExtensionAPI;
}

export function withUsageReporting<T extends { execute: (...args: any[]) => any }>(
  tool: T,
  isReportUsageEnabled: () => boolean,
  pendingUsage: PendingUsagePool,
): T {
  return {
    ...tool,
    execute: async (toolCallId: string | undefined, ...rest: any[]) => {
      const result = await tool.execute(toolCallId, ...rest);
      if (!isReportUsageEnabled() || !toolCallId) return result;
      const usage = pendingUsage.drain();
      return usage ? { ...result, usage } : result;
    },
  };
}

export function registerToolReportingUsage(
  pi: ExtensionAPI,
  tool: any,
  isReportUsageEnabled: () => boolean,
  pendingUsage: PendingUsagePool,
): void {
  pi.registerTool(withUsageReporting(tool, isReportUsageEnabled, pendingUsage));
}

export function createGetResultTool(deps: InspectToolsDeps) {
  const { resolveAgentRef, resolveMention, isShowCostEnabled, outbox } = deps;

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'The agent name (e.g. "bold-curie") or ID to check. Also accepts type handles like "@explore".',
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record) {
        // Evicted, or lost to a reload: answer from the record the session saved.
        // An evicted handle still resolves to its id through its tombstone. After
        // a reload there is no tombstone, so the saved entry's handle and alias
        // have to match on their own.
        const ref = params.agent_id.replace(/^@/, "");
        const resolved = resolveMention(ref);
        const saved = findAgentRecordEntry(
          ctx,
          resolved?.kind === "tombstone" ? resolved.entry.id : ref,
          resolved === undefined,
        );
        if (saved) {
          outbox.cancel(saved.id);
          return textResult(formatSavedAgentRecord(saved));
        }
      }
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // A terminal status can precede asynchronous worktree cleanup. Do not
      // serve or consume that result until its existing run promise settles,
      // even for a non-waiting read. Paused records must still return promptly.
      if ((params.wait && (record.status === "running" || record.status === "queued")) ||
        (record.worktree && record.status !== "running" && record.status !== "queued" && record.status !== "paused")) {
        await waitForRecord(record, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (isShowCostEnabled()) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      const header =
        `Agent: ${record.id}${record.alias ? ` (${record.alias})` : ""}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      let body: string;
      if (record.status === "running") {
        body = "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        body = `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        body = record.result?.trim() || "No output.";
      }
      // Unanswered ask_parent questions ride the result — same footer the nested
      // inline path gets; answered/superseded/dropped ones never appear. The
      // footer joins details.body too, so the rendered output matches what the
      // model reads.
      const footer = record.status !== "running" && record.status !== "queued" ? openQuestionsFooter(record) : "";
      if (footer) body = `${body}\n\n${footer}`;

      if (record.status !== "running" && record.status !== "queued" && record.status !== "paused") {
        consumeTerminalResult(record);
        outbox.cancel(record.id);
      }

      let conversationPart: string | undefined;
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          conversationPart = `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(header + body + (conversationPart ?? ""), { header, body, conversation: conversationPart });
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
      if (renderContext.isError) return new Text(text, 0, 0);
      // The model-facing text is one flat string; the split lives in details.
      // Results captured before this renderer existed carry no split — plain text.
      const d = result.details as { header?: string; body?: string; conversation?: string } | undefined;
      if (!d?.header || d.body === undefined) return new Text(text, 0, 0);
      const entry = new Container();
      entry.addChild(new Text(d.header, 0, 0));
      entry.addChild(markdownText(d.body, theme));
      if (d.conversation) {
        // A log dump, not prose: dim per line, never markdown.
        entry.addChild(new Text(d.conversation.split("\n").map(l => theme.fg("dim", l)).join("\n"), 0, 0));
      }
      return entry;
    },
  });
}

export function createSteerTool(deps: InspectToolsDeps) {
  const { resolveAgentRef, isShowCostEnabled, pi } = deps;

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'The agent name (e.g. "bold-curie") or ID to steer (must be currently running). Also accepts type handles like "@explore".',
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (isShowCostEnabled()) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

export function createAnswerTool(deps: InspectToolsDeps) {
  const { resolveAgentRef } = deps;

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.ANSWER,
    label: "Answer Agent",
    description:
      "Answer a question one of your background agents asked via ask_parent. The answer is delivered to the (still running) agent as a steering message; " +
      "if the agent already finished, resume it with the answer instead.",
    promptSnippet: "Answer a background agent's clarification question",
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'The asking agent\'s name (e.g. "bold-curie") or ID, from the question card. Also accepts type handles.',
      }),
      question_id: Type.Optional(
        Type.String({ description: "Which question to answer. Defaults to the agent's oldest open question." }),
      ),
      answer: Type.String({ description: "The decision or fact the agent asked for." }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      const qs = record?.questions ?? [];
      const q = params.question_id
        ? qs.find(x => x.id === params.question_id)
        : qs.find(x => x.state === "open" || x.state === "delivered") ?? qs[qs.length - 1];
      // Top-level children answer directly; a nested child whose question was
      // routed all the way up the (blocked) chain to the main session is
      // answerable here too — delivery entitles, not just direct ownership.
      const routed = q !== undefined && q.deliveredTo === "root";
      if (!record || (!isTopLevelAgent(record) && !routed)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (!q || (q.state !== "open" && q.state !== "delivered")) {
        const closed = !q ? ""
          : q.state === "superseded" ? ` — it was superseded by a later ask`
          : q.state === "dropped" ? ` — it was dropped when the run ended in failure or was aborted; it asked: "${q.question}"`
          : ` — its state is ${q.state}`;
        return textResult(`No open question${params.question_id ? ` "${params.question_id}"` : ""} on agent ${params.agent_id}${closed}.`);
      }
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Agent ${params.agent_id} already finished (${record.status}); the question rode its result. Resume it with the answer instead.`);
      }
      const priorState = q.state;
      q.state = "answered";
      q.answer = params.answer;
      q.answeredBy = "root";
      const message = formatAnswerSteer(q);
      try {
        if (!record.session) {
          record.pendingSteers = [...(record.pendingSteers ?? []), message];
        } else {
          await steerAgent(record.session, message);
        }
      } catch (err) {
        // Delivery failed: un-answer so the question stays open for a retry.
        q.state = priorState;
        q.answer = undefined;
        q.answeredBy = undefined;
        return textResult(`Failed to deliver the answer to agent ${params.agent_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return textResult(`Answer to ${q.id} delivered to agent ${params.agent_id}.`);
    },
  });
}
