/**
 * observe-run.test.ts — session event observation for agent runs.
 */

import { describe, expect, it, vi } from "vitest";
import { observeRun } from "../src/agent-runner.js";

describe("observeRun", () => {
  function makeSession() {
    let listener: ((event: any) => void) | undefined;
    return {
      subscribe: vi.fn((fn: (event: any) => void) => {
        listener = fn;
        return () => { listener = undefined; };
      }),
      steer: vi.fn(),
      abort: vi.fn(),
      emit: (event: any) => listener?.(event),
    };
  }

  it("does not count a proposed tool call as an execution when streaming starts", () => {
    const session = makeSession();
    const onToolActivity = vi.fn();
    const run = observeRun(session as any, { onToolActivity });

    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        },
      },
    });

    expect(onToolActivity).not.toHaveBeenCalled();

    run.unsubscribe();
  });

  it("does not count finished arguments as execution before a tool starts", () => {
    const session = makeSession();
    const onToolActivity = vi.fn();
    const run = observeRun(session as any, { onToolActivity });

    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "src/auth.ts" },
        },
        partial: { role: "assistant", content: [] },
      },
    });

    expect(onToolActivity).not.toHaveBeenCalled();

    run.unsubscribe();
  });

  it("emits onToolActivity on execution start and end", () => {
    const session = makeSession();
    const onToolActivity = vi.fn();
    const run = observeRun(session as any, { onToolActivity });

    for (const type of ["toolcall_start", "toolcall_end"]) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0,
          toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth.ts" } },
          partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
        },
      });
    }
    expect(onToolActivity).not.toHaveBeenCalled();
    session.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "src/auth.ts" },
    });
    expect(onToolActivity).toHaveBeenCalledWith({
      type: "start",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "src/auth.ts" },
    });

    session.emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "call-1",
    });
    expect(onToolActivity).toHaveBeenCalledWith({
      type: "end",
      toolName: "read",
      toolCallId: "call-1",
    });

    expect(onToolActivity.mock.calls.map(([activity]) => activity.type)).toEqual(["start", "end"]);
    run.unsubscribe();
  });
});
