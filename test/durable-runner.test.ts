import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { runDurableAgent } from "../src/runner/durable-runner.js";

function createMockCtx(): ExtensionContext {
  return {
    cwd: process.cwd(),
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

vi.setConfig({ testTimeout: 30_000 });

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

    const tempDir = mkdtempSync(join(tmpdir(), "pi-durable-test-"));
    const sm = SessionManager.create(tempDir, tempDir);
    const sessionFile = sm.getSessionFile()!;

    try {
      // Bare continuation via runAgent with a valid temporary session file
      const result = await runAgent(ctx, "Explore", undefined, {
        pi,
        resumeSessionFile: sessionFile,
      });

      expect(result).toBeDefined();
      expect(result.aborted).toBe(false);
      expect(result.session).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("provides args to beforeToolCall so tool_call extension hooks receive input without crashing", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();

    let capturedEvent: any;
    const runResult = await runDurableAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      onSessionCreated: (session: any) => {
        // Mock an extension hook like pi-bash-process-priority that listens on tool_call via extensionRunner
        session._extensionRunner.hasHandlers = (name: string) => name === "tool_call";
        session._extensionRunner.emitToolCall = async (event: any) => {
          capturedEvent = event;
          // Verify that accessing input.command does not throw
          if (event.toolName === "bash") {
            const _cmd = event.input.command;
          }
          return undefined;
        };
      },
    });

    // In runner-session, tool execution calls (session as any).agent.beforeToolCall({ toolCall, args })
    const hookContext = {
      toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "uptime" } },
      args: { command: "uptime" },
    };
    await (runResult.session.agent as any).beforeToolCall(hookContext);

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent.toolName).toBe("bash");
    expect(capturedEvent.input).toEqual({ command: "uptime" });
  });
});
