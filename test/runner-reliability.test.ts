import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Harness, type HarnessSettings, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent, setGraceTurns } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { getSessionContextPercent } from "../src/usage.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 20_000 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 5, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };
function answer(text: string, content?: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content: content ?? [{ type: "text", text }], api: "openai-completions",
    provider: "runner-faux", model: "runner-model", usage: structuredClone(usage),
    stopReason: content ? "toolUse" : "stop", timestamp: Date.now() };
}

describe("runner reliability with real durable and Pi", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "runner-reliability-"));
    faux = registerFauxProvider({ provider: "runner-faux", models: [{ id: "runner-model", contextWindow: 1000 }] });
    registerAgents(new Map([["runner-test", { name: "runner-test", description: "test", builtinToolNames: ["read"],
      extensions: false, skills: false, systemPrompt: "Test", promptMode: "replace", persistSession: false,
      inheritContext: false, runInBackground: false, isolated: false }]]));
    setGraceTurns(2);
  });
  afterEach(() => { vi.restoreAllMocks(); faux.unregister(); rmSync(cwd, { recursive: true, force: true }); });
  function start(respond: (index: number, context: any, signal: AbortSignal) => Promise<AssistantMessage>, options: any = {}) {
    const model = faux.getModel();
    const { durableSettings, ...runOptions } = options;
    if (durableSettings) {
      const open = Harness.open;
      vi.spyOn(Harness, "open").mockImplementation((storage, configuration, context) =>
        open(storage, { ...configuration, settings: durableSettings }, context));
    }
    let requests = 0;
    const stream = (_model: unknown, context: any, opts: any) => {
      const events = new AssistantMessageEventStream();
      const index = requests++;
      queueMicrotask(async () => {
        const message = await respond(index, context, opts.signal);
        events.push({ type: "start", partial: message });
        if (message.stopReason === "error" || message.stopReason === "aborted") events.push({ type: "error", reason: message.stopReason, error: message });
        else events.push({ type: "done", reason: message.stopReason, message });
        events.end();
      });
      return events;
    };
    const ctx: any = { cwd, isProjectTrusted: () => true, model, getSystemPrompt: () => "Parent", modelRegistry: {
      find: () => model, getAll: () => [model], getAvailable: () => [model], hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }), streamSimple: stream, stream,
    } };
    return runAgent(ctx, "runner-test", "first", { pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) }, ...runOptions });
  }
  it("waits for follow-ups, reports live usage once, and restores queue methods", async () => {
    const first = deferred(); const second = deferred(); const secondStarted = deferred();
    let session: any; let original: unknown;
    const deltas: number[] = [];
    const contexts: any[] = [];
    const running = start(async (index, context) => {
      contexts.push(context);
      if (index === 0) await first.promise;
      else { secondStarted.resolve(); await second.promise; }
      return answer(index === 0 ? "first answer" : "second answer");
    }, { onSessionCreated: (value: any) => { session = value; original = value.agent.steer; },
      onAssistantUsage: (value: any) => deltas.push(value.output) });
    await vi.waitFor(() => expect(session?.isStreaming).toBe(true));
    await session.followUp("follow-up", [{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    first.resolve();
    await secondStarted.promise;
    expect(deltas).toEqual([3]); // live, while the accepted successor is blocked
    expect(getSessionContextPercent(session)).toBe(2);
    second.resolve();
    const result = await running;
    expect(result.responseText).toBe("second answer");
    expect(deltas).toEqual([3, 3]);
    expect(contexts[1].messages.some((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image"))).toBe(true);
    expect(session.agent.steer).toBe(original);
    expect(session.pendingMessageCount).toBe(0);
    expect(session.messages.filter((m: any) => m.role === "user")).toHaveLength(2);
    expect(session.messages.some((m: any) => m.role === "system")).toBe(false);
  });
  it("hard-aborts durable before hard-boundary tool execution with exact grace", async () => {
    const activity: any[] = []; const contexts: any[] = [];
    const result = await start(async (index, context) => {
      contexts.push(context);
      return answer("", [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "missing" } }]);
    }, { maxTurns: 1, onToolActivity: (event: any) => activity.push(event) });
    expect(contexts).toHaveLength(3);
    expect(contexts[1].messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("turn limit"))).toBe(true);
    expect(activity.filter((e) => e.type === "start")).toHaveLength(2);
    expect(activity.filter((e) => e.type === "end")).toHaveLength(2);
    expect(result.aborted).toBe(true);
    expect(result.failure).toBeUndefined();
  });
  it("allows a final answer on the soft boundary without a needless successor", async () => {
    let requests = 0;
    const result = await start(async () => { requests++; return answer("done"); }, { maxTurns: 1 });
    expect(requests).toBe(1);
    expect(result.responseText).toBe("done");
    expect(result.aborted).toBe(false);
  });
  it("persists completed work on abort and counts the aborted response once", async () => {
    const secondStarted = deferred(); const controller = new AbortController(); const deltas: number[] = [];
    const running = start(async (index, _context, signal) => {
      if (index === 0) return answer("", [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "missing" } }]);
      secondStarted.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...answer(""), stopReason: "aborted" };
    }, { signal: controller.signal, onAssistantUsage: (value: any) => deltas.push(value.output) });
    await secondStarted.promise;
    expect(deltas).toEqual([3]);
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "assistant").length).toBeGreaterThanOrEqual(1);
    expect(deltas).toEqual([3, 3]);
  });
  it("restores actual prior tool arguments, results and images without repeating history", async () => {
    const manager = SessionManager.create(cwd, cwd);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 1 });
    manager.appendMessage(answer("", [{ type: "toolCall", id: "prior", name: "read", arguments: { path: "exact-name" } }]));
    manager.appendMessage({ role: "toolResult", toolCallId: "prior", toolName: "read", content: [{ type: "text", text: "prior result" }], isError: false, timestamp: 2 });
    let received: any;
    const result = await start(async (_index, context) => { received = context.messages; return answer("restored"); }, { resumeSessionFile: manager.getSessionFile() });
    expect(JSON.stringify(received)).toContain("exact-name");
    expect(JSON.stringify(received)).toContain("YWJj");
    expect(received.find((m: any) => m.role === "toolResult").toolCallId).toBe("prior");
    expect(result.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(result.session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(2);
  });
  it("collects a failing follow-up without cancelling it or hanging queued inputs", async () => {
    const first = deferred(); let session: any;
    const running = start(async (index) => {
      if (index === 0) { await first.promise; return answer("initial answer"); }
      return { ...answer(""), stopReason: "error", errorMessage: "invalid provider request" };
    }, { onSessionCreated: (value: any) => { session = value; } });
    await vi.waitFor(() => expect(session?.isStreaming).toBe(true));
    await session.followUp("first follow-up");
    await session.followUp("second follow-up");
    first.resolve();
    const result = await running;
    expect(result.failure).toBe("invalid provider request");
    expect(result.aborted).toBe(false);
  });

  it("reports retry usage live and persists failed attempts without double replay", async () => {
    const retryStarted = deferred(); const finishRetry = deferred(); const deltas: number[] = [];
    const running = start(async (index) => {
      if (index === 0) return { ...answer(""), stopReason: "error", errorMessage: "503 Service Unavailable" };
      retryStarted.resolve();
      await finishRetry.promise;
      return answer("retry succeeded");
    }, { durableSettings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } } satisfies HarnessSettings,
      onAssistantUsage: (value: any) => deltas.push(value.output) });
    await retryStarted.promise;
    expect(deltas).toEqual([3]);
    finishRetry.resolve();
    const result = await running;
    expect(result.responseText).toBe("retry succeeded");
    expect(result.failure).toBeUndefined();
    expect(deltas).toEqual([3, 3]);
    const assistants = result.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(result.session.messages.filter((message) => message.role === "assistant").map((message) => message.stopReason)).toEqual(["error", "stop"]);
  });

  it("preserves pre-compaction usage and raw history through real durable compaction", async () => {
    const afterCompaction = deferred(); const finish = deferred(); const deltas: number[] = [];
    const storage = new MemoryStorage(); let summaries = 0; let turns = 0;
    const contexts: any[] = [];
    const running = start(async (_index, context) => {
      contexts.push(context);
      const isSummary = context.messages.some((message: any) => message.role === "system" && typeof message.content === "string" && message.content.includes("context summarization assistant"));
      if (isSummary) {
        summaries++;
        return answer("compact checkpoint");
      }
      turns++;
      if (turns === 1) return answer("", [{ type: "text", text: "before-compaction" }, { type: "toolCall", id: "compact-read", name: "read", arguments: { path: "missing" } }]);
      if (turns === 2) return answer("", [{ type: "toolCall", id: "compact-read2", name: "read", arguments: { path: "missing2" } }]);
      afterCompaction.resolve();
      await finish.promise;
      return answer("after compact answer");
    }, { storage,
      durableSettings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 999, keepRecentTokens: 1, backgroundTokens: 0 } } satisfies HarnessSettings,
      onAssistantUsage: (value: any) => deltas.push(value.output),
    });
    await afterCompaction.promise;
    expect(summaries).toBeGreaterThan(0);
    expect(deltas).toHaveLength(turns - 1 + summaries);
    expect(deltas.every((output) => output === 3)).toBe(true);
    const latest = contexts[contexts.length - 1].messages;
    expect(JSON.stringify(latest)).toContain("compact checkpoint");
    expect(JSON.stringify(latest)).not.toContain("before-compaction");
    finish.resolve();
    const result = await running;
    expect(result.failure).toBeUndefined();
    expect(deltas).toHaveLength(turns + summaries);
    expect(getSessionContextPercent(result.session)).toBe(2);
    expect(result.session.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("before-compaction"))).toBe(true);
    const persisted = result.session.sessionManager.getEntries();
    expect(persisted.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("before-compaction"))).toBe(true);
    expect(persisted.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("compact checkpoint"))).toBe(true);
  });

  it("retries a failed mid-entry append without losing or duplicating messages", async () => {
    const open = Harness.open;
    vi.spyOn(Harness, "open").mockImplementation(async (storage, configuration, context) => {
      const harness = await open(storage, configuration, context);
      const root = harness.root.bind(harness);
      vi.spyOn(harness, "root").mockImplementation(async (...args) => {
        const conversation = await root(...args);
        const entries = conversation.entries.bind(conversation);
        vi.spyOn(conversation, "entries").mockImplementation(async (...query) => {
          const page = await entries(...query);
          return { ...page, items: page.items.map((entry) => entry.kind === "pi.assistant"
            ? { ...entry, model: [answer("part one"), answer("part two"), answer("part three")] } : entry) };
        });
        return conversation;
      });
      return harness;
    });
    let session: any; let failed = false;
    const running = start(async () => answer("done"), { onSessionCreated: (value: any) => {
      session = value;
      const append = value.sessionManager.appendMessage.bind(value.sessionManager);
      vi.spyOn(value.sessionManager, "appendMessage").mockImplementation((message: any) => {
        if (!failed && JSON.stringify(message.content).includes("part two")) {
          failed = true;
          throw new Error("transient disk failure");
        }
        return append(message);
      });
    } });
    await expect(running).rejects.toThrow("transient disk failure");
    expect(failed).toBe(true);
    const texts = session.sessionManager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "assistant")
      .map((entry: any) => entry.message.content[0].text);
    expect(texts).toEqual(["part one", "part two", "part three"]);
    expect(session.messages.filter((message: any) => message.role === "assistant").map((message: any) => message.content[0].text)).toEqual(texts);
  });

  it.each(["control", "persistence"])("always cleans up after %s settlement fails", async (failure) => {
    const open = Harness.open; const closed = vi.fn();
    vi.spyOn(Harness, "open").mockImplementation(async (storage, configuration, context) => {
      const harness = await open(storage, configuration, context);
      const close = harness.close.bind(harness);
      vi.spyOn(harness, "close").mockImplementation(async (...args) => { closed(); await close(...args); });
      return harness;
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const unsubscribed = vi.fn(); let subscriptions = 0;
    let session: any; let originalSteer: unknown; let originalFollowUp: unknown;
    let originalState: unknown; let stateDescriptor: PropertyDescriptor | undefined;
    let streamingDescriptor: PropertyDescriptor | undefined;
    const running = start(async (index) => index === 0 && failure === "control"
      ? answer("", [{ type: "toolCall", id: "control-read", name: "read", arguments: { path: "missing" } }])
      : answer("done"), { signal: controller.signal, maxTurns: 1, onSessionCreated: (value: any) => {
      session = value;
      originalSteer = value.agent.steer; originalFollowUp = value.agent.followUp;
      originalState = value.agent.state;
      stateDescriptor = Object.getOwnPropertyDescriptor(value.agent, "state");
      streamingDescriptor = Object.getOwnPropertyDescriptor(value, "isStreaming");
      const subscribe = value.subscribe.bind(value);
      vi.spyOn(value, "subscribe").mockImplementation((listener: any) => {
        subscriptions++;
        const unsubscribe = subscribe(listener);
        return () => { unsubscribed(); unsubscribe(); };
      });
      if (failure === "control") vi.spyOn(value, "steer").mockRejectedValue(new Error("control failed"));
      else vi.spyOn(value.sessionManager, "appendMessage").mockImplementation(() => { throw new Error("persistence failed"); });
    } });
    await expect(running).rejects.toThrow(`${failure} failed`);
    expect(session.agent.steer).toBe(originalSteer);
    expect(session.agent.followUp).toBe(originalFollowUp);
    expect(session.agent.state).toBe(originalState);
    expect(Object.getOwnPropertyDescriptor(session.agent, "state")).toEqual(stateDescriptor);
    expect(Object.getOwnPropertyDescriptor(session, "isStreaming")).toEqual(streamingDescriptor);
    expect(session.isStreaming).toBe(false);
    expect(unsubscribed).toHaveBeenCalledTimes(subscriptions);
    expect(subscriptions).toBe(2);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("leaves native state untouched when opening durable storage fails", async () => {
    vi.spyOn(Harness, "open").mockRejectedValue(new Error("storage open failed"));
    let session: any; let state: unknown;
    let stateDescriptor: PropertyDescriptor | undefined; let streamingDescriptor: PropertyDescriptor | undefined;
    await expect(start(async () => answer("unused"), { onSessionCreated: (value: any) => {
      session = value; state = value.agent.state;
      stateDescriptor = Object.getOwnPropertyDescriptor(value.agent, "state");
      streamingDescriptor = Object.getOwnPropertyDescriptor(value, "isStreaming");
    } })).rejects.toThrow("storage open failed");
    expect(session.agent.state).toBe(state);
    expect(Object.getOwnPropertyDescriptor(session.agent, "state")).toEqual(stateDescriptor);
    expect(Object.getOwnPropertyDescriptor(session, "isStreaming")).toEqual(streamingDescriptor);
    expect(session.isStreaming).toBe(false);
  });

  it("uses the finalized built-in tool result in the provider context and saved transcript", async () => {
    writeFileSync(join(cwd, "private.txt"), "secret-original");
    let received: ToolResultMessage | undefined;
    const result = await start(async (index, context) => {
      if (index === 0) return answer("", [{ type: "toolCall", id: "redact-read", name: "read", arguments: { path: "private.txt" } }]);
      received = context.messages.find((message: { role: string }) => message.role === "toolResult");
      return answer("done");
    }, { onSessionCreated: (session: AgentSession) => {
      session.agent.afterToolCall = async () => ({
        content: [{ type: "text", text: "redacted" }], details: { redacted: true }, isError: true,
      });
    } });
    expect(received?.content).toEqual([{ type: "text", text: "redacted" }]);
    expect(received?.isError).toBe(true);
    const saved = result.session.messages.find((message) => message.role === "toolResult");
    expect(saved).toMatchObject({ content: received?.content, details: { redacted: true }, isError: true });
  });

  it.each([false, true])("finalizes thrown built-in errors once with hook failure=%s", async hookFails => {
    let received: ToolResultMessage | undefined;
    const hook = vi.fn(async () => {
      if (hookFails) throw new Error("hook failed safely");
      return { content: [{ type: "text", text: "redacted failure" }], details: { redacted: true }, isError: true };
    });
    const result = await start(async (index, context) => {
      if (index === 0) return answer("", [{ type: "toolCall", id: "failed-read", name: "read", arguments: { path: "missing-private-file" } }]);
      received = context.messages.find((message: { role: string }) => message.role === "toolResult");
      return answer("done");
    }, { onSessionCreated: (session: AgentSession) => { session.agent.afterToolCall = hook; } });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(received?.content).toEqual([{ type: "text", text: hookFails ? "hook failed safely" : "redacted failure" }]);
    expect(received?.isError).toBe(true);
    expect(result.session.messages.find(message => message.role === "toolResult")).toMatchObject({ content: received?.content, isError: true });
  });

  it("returns saved completed bare answers rather than empty success", async () => {
    const result = await start(async () => answer("saved"));
    const resumed = await resumeAgent(result.session, { type: "runner-test" });
    expect(resumed.text).toBe("saved");
    expect(resumed.failure).toBeUndefined();
  });
});
