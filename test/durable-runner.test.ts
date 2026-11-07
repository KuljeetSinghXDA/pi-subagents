import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { runDurableAgent } from "../src/runner/durable-runner.js";

function createMockCtx(): ExtensionContext {
  return {
    cwd: "/mock/project",
    getSystemPrompt: () => "You are a test assistant.",
    model: { provider: "mock-provider", id: "mock-model" },
    modelRegistry: {
      find: vi.fn(),
      getAvailable: () => [],
    },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function createMockPi(): ExtensionAPI {
  return {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
  } as unknown as ExtensionAPI;
}

describe("runDurableAgent", () => {
  it("initializes a durable root conversation and bare continuation", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();

    const onSessionCreated = vi.fn();
    const result = await runDurableAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      onSessionCreated,
    });

    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(false);
    expect(result.responseText).toBe("");
    expect(result.session).toBeDefined();
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(result.session.messages).toEqual([]);
  });

  it("handles pre-aborted signal cleanly", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();

    const controller = new AbortController();
    controller.abort();

    const result = await runDurableAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
  });

  it("routes universally through runAgent with durable execution", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();

    // Bare continuation via runAgent
    const result = await runAgent(ctx, "Explore", undefined, {
      pi,
      resumeSessionFile: "/mock/session.jsonl", // bypass required prompt check
    });

    expect(result).toBeDefined();
    expect(result.aborted).toBe(false);
    expect(result.session).toBeDefined();
  });

  it("suspends on beforeToolCall when paused and resumes when released", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();

    let beforeToolCallCalled = false;
    let gateResolved = false;
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = () => {
        gateResolved = true;
        resolve();
      };
    });

    const testTool = {
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return { content: [{ type: "text", text: "done" }] };
      },
    };

    // When session is created, attach beforeToolCall (like installPauseGate does)
    const onSessionCreated = (session: any) => {
      session.agent.beforeToolCall = async () => {
        beforeToolCallCalled = true;
        await gatePromise;
      };
    };

    // Start durable run with testTool as custom tool
    const runPromise = runDurableAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      onSessionCreated,
      tools: [testTool as any],
    });

    const runResult = await runPromise;
    expect(runResult.session).toBeDefined();
    expect(runResult.session.agent?.beforeToolCall).toBeDefined();

    // Call beforeToolCall directly as the durable tool execution does
    const boundaryPromise = runResult.session.agent.beforeToolCall({ toolCall: { name: "test_tool" } });
    expect(beforeToolCallCalled).toBe(true);
    expect(gateResolved).toBe(false);

    // Release gate
    releaseGate();
    await boundaryPromise;
    expect(gateResolved).toBe(true);
  });
});
