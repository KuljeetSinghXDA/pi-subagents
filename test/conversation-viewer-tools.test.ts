/**
 * conversation-viewer-tools.test.ts — how the chat transcript builds tool blocks.
 *
 * Two things the viewer must get from pi's own replay of a saved session rather
 * than from its live path: the arguments are final (so the render context does
 * not claim `argsComplete`, which makes the edit renderer read the file from
 * disk), and a call that never ran says why instead of looking pending forever.
 */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { fallbackMarkdownTheme } from "../src/ui/viewer/viewer-types.js";

// The tool component draws with pi's global theme; only the TUI normally sets it up.
initTheme(undefined, false);

const { buildTranscript } = await import("../src/ui/viewer/viewer-content.js");

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

/** A session holding `messages`, with the tool definitions a test registers. */
function mockSession(messages: any[], definitions: Record<string, any> = {}) {
  return {
    messages,
    state: {},
    getToolDefinition: (name: string) => definitions[name],
    extensionRunner: undefined,
  } as any;
}

function build(session: any, record: Partial<AgentRecord> = {}) {
  const invalidate = vi.fn();
  const componentCache = new WeakMap<object, any>();
  const build = buildTranscript({
    tui: { requestRender: () => {} } as any,
    session,
    record: {
      id: "test-1",
      type: "general-purpose",
      description: "test agent",
      status: "completed",
      toolUses: 1,
      startedAt: 1,
      ...record,
    } as AgentRecord,
    activity: undefined,
    theme,
    markdownTheme: fallbackMarkdownTheme(theme),
    partials: new Map(),
    expanded: false,
    invalidate,
    assistantComponents: new WeakMap(),
    toolComponents: componentCache,
    toolFeeds: new WeakMap(),
  });
  return { ...build, invalidate, lines: () => build.container.render(120).join("\n") };
}

function assistant(content: any[], extra: Record<string, unknown> = {}) {
  return { role: "assistant", content, stopReason: "toolUse", ...extra };
}

function editCall(id = "call-1") {
  return assistant([
    { type: "toolCall", id, name: "edit", arguments: { path: "a.ts", oldText: "a", newText: "b" } },
  ]);
}

describe("chat transcript tool blocks", () => {
  let seen: any[];

  beforeEach(() => {
    seen = [];
  });

  /** Records the render context the transcript hands the renderer, then draws one line. */
  function recordingDefinition() {
    return {
      renderCall(args: any, _theme: any, context: any) {
        seen.push(context);
        return { render: () => [`call: ${JSON.stringify(args)}`], invalidate: () => {} };
      },
    };
  }

  it("builds a call the way pi replays a saved session: arguments final, not started", () => {
    const session = mockSession([editCall()], { edit: recordingDefinition() });
    const { lines, invalidate } = build(session);

    expect(lines()).toContain("a.ts");
    expect(seen).toHaveLength(1);
    expect(seen[0].argsComplete).toBe(false);
    expect(seen[0].executionStarted).toBe(false);
    // A render request from inside the build would dirty the line cache the
    // build is filling and force a second full render.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says why a call from an aborted response never ran", () => {
    const aborted = assistant(
      [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts" } }],
      { stopReason: "aborted" },
    );
    const { lines } = build(mockSession([aborted], {}), { status: "aborted" });

    expect(lines()).toContain("edit");
    expect(lines()).toContain("Operation aborted");
  });

  it("shows the provider's error for a call from a failed response", () => {
    const failed = assistant(
      [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts" } }],
      { stopReason: "error", errorMessage: "provider exploded" },
    );
    const { lines } = build(mockSession([failed], {}));

    expect(lines()).toContain("provider exploded");
  });

  it("folds a result into its call instead of rendering a second block", () => {
    const session = mockSession([
      editCall(),
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "THE-TOOL-OUTPUT" }], isError: false },
    ]);
    const { lines } = build(session);

    expect(lines()).toContain("THE-TOOL-OUTPUT");
    expect(lines()).not.toContain("[Result]");
    expect(lines()).not.toContain("Operation aborted");
  });

  it("renders MCP tool calls with arguments and folds result cleanly", () => {
    const mcpCall = assistant([
      {
        type: "toolCall",
        id: "call-mcp-1",
        name: "mcp__github__search_issues",
        arguments: { query: "is:open label:bug", limit: 5 },
      },
    ]);
    const session = mockSession([
      mcpCall,
      {
        role: "toolResult",
        toolName: "mcp__github__search_issues",
        toolCallId: "call-mcp-1",
        content: [{ type: "text", text: "Found 2 matching issues" }],
        isError: false,
      },
    ]);
    const { lines } = build(session);
    const rendered = lines();

    expect(rendered).toContain("mcp__github__search_issues");
    expect(rendered).toContain("query");
    expect(rendered).toContain("Found 2 matching issues");
    expect(rendered).not.toContain("[Result]");
    expect(rendered).not.toContain("[object Object]");
  });

  it("renders extension tool calls using custom renderCall and renderResult", () => {
    const extCall = assistant([
      {
        type: "toolCall",
        id: "call-ext-1",
        name: "custom_analyzer",
        arguments: { target: "src/index.ts" },
      },
    ]);
    const customDefinition = {
      renderCall(args: any) {
        return { render: () => [`[CUSTOM_CALL: ${args.target}]`], invalidate: () => {} };
      },
      renderResult(result: any) {
        return { render: () => [`[CUSTOM_RESULT: ${result.content?.[0]?.text}]`], invalidate: () => {} };
      },
    };
    const session = mockSession(
      [
        extCall,
        {
          role: "toolResult",
          toolName: "custom_analyzer",
          toolCallId: "call-ext-1",
          content: [{ type: "text", text: "Analysis: 0 defects" }],
          isError: false,
        },
      ],
      { custom_analyzer: customDefinition },
    );
    const { lines } = build(session);
    const rendered = lines();

    expect(rendered).toContain("[CUSTOM_CALL: src/index.ts]");
    expect(rendered).toContain("[CUSTOM_RESULT: Analysis: 0 defects]");
    expect(rendered).not.toContain("[Result]");
    expect(rendered).not.toContain("[object Object]");
  });
});
