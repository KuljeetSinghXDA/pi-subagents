import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { bridgePiToolToDurableTool, type ExecutablePiTool } from "../src/runner/durable-tool-bridge.js";

describe("bridgePiToolToDurableTool", () => {
  it("converts a Pi tool into a durable ToolRegistration with start/end activity", async () => {
    const activities: any[] = [];
    const mockTool: ExecutablePiTool = {
      name: "mcp__calculator__add",
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      execute: vi.fn(async (_callId, params) => {
        return {
          content: [{ type: "text", text: String(params.a + params.b) }],
          details: { sum: params.a + params.b },
        };
      }),
    };

    const durableTool = bridgePiToolToDurableTool(mockTool, {
      onActivity: (act) => activities.push(act),
    });

    expect(durableTool.name).toBe("mcp__calculator__add");
    expect(durableTool.description).toBe("Add two numbers");
    expect(durableTool.replay).toBe("unsafe");

    const mockApi: any = {
      output: vi.fn(),
    };

    const result = await durableTool.execute({ a: 10, b: 25 }, mockApi, BACKGROUND_CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.output).toEqual([{ type: "text", text: "35" }]);
    expect(result.details).toEqual({ sum: 35 });
    expect(mockTool.execute).toHaveBeenCalledTimes(1);

    expect(activities.length).toBe(2);
    expect(activities[0].type).toBe("start");
    expect(activities[0].toolName).toBe("mcp__calculator__add");
    expect(activities[0].args).toEqual({ a: 10, b: 25 });
    expect(activities[1].type).toBe("end");
    expect(activities[1].toolName).toBe("mcp__calculator__add");
  });

  it("marks read-only inspection tools as replay-safe", () => {
    const readTool: ExecutablePiTool = {
      name: "read",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableRead = bridgePiToolToDurableTool(readTool);
    expect(durableRead.replay).toBe("safe");

    const grepTool: ExecutablePiTool = {
      name: "grep",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableGrep = bridgePiToolToDurableTool(grepTool);
    expect(durableGrep.replay).toBe("safe");

    const bashTool: ExecutablePiTool = {
      name: "bash",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableBash = bridgePiToolToDurableTool(bashTool);
    expect(durableBash.replay).toBe("unsafe");
  });

  it("catches errors and reports isError: true", async () => {
    const failingTool: ExecutablePiTool = {
      name: "failing_tool",
      parameters: {},
      execute: async () => {
        throw new Error("Network timeout contacting MCP service");
      },
    };

    const durableTool = bridgePiToolToDurableTool(failingTool);
    const mockApi: any = { output: vi.fn() };

    const result = await durableTool.execute({}, mockApi, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ type: "text", text: "Network timeout contacting MCP service" }]);
  });
});
