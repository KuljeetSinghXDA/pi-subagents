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
});
