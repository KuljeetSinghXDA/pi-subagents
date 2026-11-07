import { describe, expect, it } from "vitest";
import { createActivityTracker, renderRunningAgentStatus } from "../src/index.js";
import { type ActiveToolCall, AgentWidget, describeActivity, fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

// While an agent streams text with no tool mid-flight, the `⎿` line shows a
// line from that text. It must be the LAST line of the stream — what the agent
// is writing right now — not the first, which completes as soon as the first
// `\n` arrives and would otherwise pin the subtext to the message's opening
// sentence for the rest of the message.
describe("describeActivity text fallback", () => {
  const noTools = new Map<string, ActiveToolCall>();

  it("shows the latest line of streamed text, not the first", () => {
    const streamed = "Let me look at the files.\nReading the config now.\nFound three suspects in src/auth.ts.";
    expect(describeActivity(noTools, streamed)).toBe("Found three suspects in src/auth.ts.");
  });

  it("rolls forward as new lines arrive", () => {
    // Same message, two points in its stream: the displayed line must move.
    const before = describeActivity(noTools, "First line done.\n");
    const after = describeActivity(noTools, "First line done.\nSecond line is the current one.");
    expect(before).toBe("First line done.");
    expect(after).toBe("Second line is the current one.");
  });

  it("skips blank and whitespace-only lines when finding the latest", () => {
    const streamed = "Opening line.\n\n   \n\nLatest after a gap.\n";
    expect(describeActivity(noTools, streamed)).toBe("Latest after a gap.");
  });

  it("still truncates the picked line to 60 chars with an ellipsis", () => {
    const long = "x".repeat(80);
    expect(describeActivity(noTools, `short preamble.\n${long}`)).toBe("x".repeat(60) + "…");
  });

  it("keeps tool activity ahead of response text", () => {
    const reading = new Map<string, ActiveToolCall>([
      ["call-1", { toolName: "read", args: { path: "src/a.ts" } }],
      ["call-2", { toolName: "read", args: { path: "src/b.ts" } }],
    ]);
    expect(describeActivity(reading, "some streamed text")).toBe("reading src/a.ts, reading src/b.ts…");
  });

  it("falls back to thinking… with no tools and no text", () => {
    expect(describeActivity(noTools, "")).toBe("thinking…");
    expect(describeActivity(noTools, "\n \n")).toBe("thinking…");
  });
});

describe("describeActivity tool phrases", () => {
  const calls = (list: [string, ActiveToolCall][]) => new Map<string, ActiveToolCall>(list);

  it("names the file an edit targets", () => {
    const active = calls([["c1", { toolName: "edit", args: { path: "src/auth.ts", edits: [] } }]]);
    expect(describeActivity(active)).toBe("editing src/auth.ts…");
  });

  it("keeps bash generic — command fragments read as noise", () => {
    const active = calls([["c1", { toolName: "bash", args: { command: "cd /home/app && npm run check --silent" } }]]);
    expect(describeActivity(active)).toBe("running command…");
  });

  it("quotes search patterns", () => {
    const active = calls([["c1", { toolName: "grep", args: { pattern: "max turns" } }]]);
    expect(describeActivity(active)).toBe("searching 'max turns'…");
  });

  it("uses the raw tool name for unmapped tools, with or without args", () => {
    expect(describeActivity(calls([["c1", { toolName: "web_search" }]]))).toBe("web_search…");
    expect(describeActivity(calls([["c1", { toolName: "document_parse", args: { path: "doc.pdf" } }]]))).toBe("document_parse…");
  });

  it("joins distinct phrases and counts the overflow", () => {
    const active = calls([
      ["c1", { toolName: "edit", args: { path: "a.ts" } }],
      ["c2", { toolName: "read", args: { path: "b.ts" } }],
      ["c3", { toolName: "grep", args: { pattern: "x" } }],
      ["c4", { toolName: "bash", args: { command: "npm test" } }],
    ]);
    expect(describeActivity(active)).toBe("editing a.ts, reading b.ts, searching 'x' +1 more…");
  });

  it("deduplicates identical phrases", () => {
    const active = calls([
      ["c1", { toolName: "read", args: { path: "a.ts" } }],
      ["c2", { toolName: "read", args: { path: "a.ts" } }],
    ]);
    expect(describeActivity(active)).toBe("reading a.ts…");
  });

  it("clamps the joined phrase to 60 chars", () => {
    const active = calls([["c1", { toolName: "edit", args: { path: `${"d/".repeat(30)}file.ts` } }]]);
    const text = describeActivity(active);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("createActivityTracker", () => {
  it("pairs start/end by toolCallId, leaving same-name calls alone", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onToolActivity({ type: "start", toolName: "read", toolCallId: "t1", args: { path: "a.ts" } });
    callbacks.onToolActivity({ type: "start", toolName: "read", toolCallId: "t2", args: { path: "b.ts" } });
    expect(state.activeTools.get("t1")).toEqual({ toolName: "read", args: { path: "a.ts" } });
    callbacks.onToolActivity({ type: "end", toolName: "read", toolCallId: "t1" });
    expect([...state.activeTools.keys()]).toEqual(["t2"]);
    expect(state.toolUses).toBe(1);
  });

  it("matches ends by tool name when no toolCallId is given", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onToolActivity({ type: "start", toolName: "grep" });
    callbacks.onToolActivity({ type: "end", toolName: "grep" });
    expect(state.activeTools.size).toBe(0);
    expect(state.toolUses).toBe(1);
  });

  it("keeps the previous message's text until the next delta replaces it", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onTextDelta("tail of the old message", "tail of the old message");
    expect(state.responseText).toBe("tail of the old message");
    // The text is never cleared between messages — the last output line stays
    // visible through the thinking window, per the spec and upstream behavior.
    callbacks.onTextDelta("new", "new");
    expect(state.responseText).toBe("new");
  });

  it("records the last completed tool call for between-message display", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onToolActivity({ type: "start", toolName: "grep", toolCallId: "t9", args: { pattern: "maxTurns" } });
    callbacks.onToolActivity({ type: "end", toolName: "grep", toolCallId: "t9" });
    expect(state.lastTool).toEqual({ toolName: "grep", args: { pattern: "maxTurns" } });
    expect(state.activeTools.size).toBe(0);
  });

  it("shows completed tool call instead of reverting to earlier narration", () => {
    const { state, callbacks } = createActivityTracker();
    // Turn 1 starts with narration:
    callbacks.onTextDelta("I will investigate the codebase.", "I will investigate the codebase.");
    expect(describeActivity(state.activeTools, state.responseText, state.lastTool, (state as any).lastActivity === "tool"))
      .toBe("I will investigate the codebase.");

    // Turn 1 tool runs:
    callbacks.onToolActivity({ type: "start", toolName: "read", toolCallId: "t1", args: { path: "src/index.ts" } });
    expect(describeActivity(state.activeTools, state.responseText, state.lastTool, (state as any).lastActivity === "tool"))
      .toBe("reading src/index.ts…");

    // Turn 1 tool completes:
    callbacks.onToolActivity({ type: "end", toolName: "read", toolCallId: "t1" });
    expect(describeActivity(state.activeTools, state.responseText, state.lastTool, (state as any).lastActivity === "tool"))
      .toBe("read src/index.ts");
  });
});

describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");    // not ~$0.0500
    expect(formatCost(0.4)).toBe("~$0.40");     // not ~$0.4
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    // Zero is what a model with no pricing data reports, so `$0.00` would claim
    // a measurement that was never made.
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    // The tilde is the whole disclaimer — it sits beside exact token counts.
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget status bar", () => {
  const theme = {
    fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
    bold: (s: string) => s,
  };

  it("formats status bar with themed accent icon and dim label in Pi style", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("<accent>⠋</accent> <dim>1 running agent</dim>");
  });

  it("formats status bar as plain text in Claude style even with theme", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => false,
      () => false,
      () => "claude",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("1 running agent");
  });

  it("formats status bar as plain text when no theme is present on UICtx", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("1 running agent");
  });

  it("clears status bar when all agents finish and clear", () => {
    const agent = {
      id: "agent-1",
      type: "general-purpose",
      description: "worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      new Map(),
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBeDefined();

    agent.status = "completed" as any;
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    widget.update();
    expect(statusText).toBeUndefined();
  });
});

