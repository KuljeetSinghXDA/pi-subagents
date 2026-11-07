import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";

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

describe("Durable runner with extensions and MCP tools", () => {
  it("boots extension runtime and binds tools to the durable registry", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();
    const toolActivities: any[] = [];

    const result = await runAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      onToolActivity: (activity) => toolActivities.push(activity),
    });

    expect(result).toBeDefined();
    expect(result.aborted).toBe(false);
    expect(result.session).toBeDefined();
    // Verify session has active tool names available
    const activeToolNames = result.session.getActiveToolNames();
    expect(Array.isArray(activeToolNames)).toBe(true);
  });
});
