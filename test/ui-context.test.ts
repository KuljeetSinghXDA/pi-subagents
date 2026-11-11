import { describe, expect, it } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";
import { agentHeaderLines } from "../src/ui/hub/hub-headers.js";
import { buildOwnIdentityLines } from "../src/ui/viewer/viewer-chrome.js";
import { clearDurableContextUsage, type SessionLike, setDurableContextUsage } from "../src/usage.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const sessionWithPercent = (percent: number | null): SessionLike => ({
  getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 0 }, contextUsage: { percent } }),
});

function recordWithSession(session?: SessionLike): AgentRecord {
  return {
    id: "context-agent",
    type: "general-purpose",
    description: "context display",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 0 },
    session,
  } as AgentRecord;
}

function contextText(record: AgentRecord, activity?: AgentActivity): string[] {
  const tracker = new Map<string, AgentActivity>(activity ? [[record.id, activity]] : []);
  const manager = { listAgents: () => [record] } as unknown as AgentManager;
  const widget = new AgentWidget(manager, tracker);
  return [
    widget.renderWidget({ terminal: { columns: 300, rows: 40 } }, theme).join("\n"),
    agentHeaderLines({ record, activity, width: 300, th: theme }).flat().map(segment => segment.text).join(""),
    buildOwnIdentityLines(record, activity, theme, false).join("\n"),
  ];
}

describe("UI context session selection", () => {
  it("shows streamed record tokens even when background stats still report zero", () => {
    const record = recordWithSession(sessionWithPercent(63));
    record.lifetimeUsage = { input: 1_000, output: 200, cacheWrite: 0 };
    const activity: AgentActivity = {
      session: {
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 0 } }),
      },
      activeTools: new Map(), responseText: "", toolUses: 0, turnCount: 1,
    };
    for (const text of contextText(record, activity)) {
      expect(text).toContain("1.2k token");
      expect(text).toContain("63%");
    }
    record.lifetimeUsage.output += 100;
    for (const text of contextText(record, activity)) expect(text).toContain("1.3k token");
  });

  it("reads record context without an activity entry in every display", () => {
    for (const text of contextText(recordWithSession(sessionWithPercent(63)))) {
      expect(text).toContain("63%");
    }
  });

  it("prefers the record session over stale tracker context", () => {
    const activity = {
      session: sessionWithPercent(5), activeTools: new Map(), responseText: "", turnCount: 1,
    } as AgentActivity;
    for (const text of contextText(recordWithSession(sessionWithPercent(63)), activity)) {
      expect(text).toContain("63%");
      expect(text).not.toContain("5%");
    }
  });

  it("still falls back to tracker context when the record has no session", () => {
    const activity = {
      session: sessionWithPercent(42), activeTools: new Map(), responseText: "", turnCount: 1,
    } as AgentActivity;
    for (const text of contextText(recordWithSession(), activity)) expect(text).toContain("42%");
  });

  it("keeps completed durable context and removes it when native compaction invalidates it", () => {
    const session = sessionWithPercent(null);
    const record = recordWithSession(session);
    setDurableContextUsage(session, { input: 10, output: 10, cacheRead: 20, cacheWrite: 40 }, 100);
    for (const text of contextText(record)) expect(text).toContain("80%");
    record.status = "completed";
    record.completedAt = Date.now();
    const completed = contextText(record).slice(1); // Finished widget lines intentionally omit context.
    for (const text of completed) expect(text).toContain("80%");
    clearDurableContextUsage(session);
    for (const text of contextText(record)) expect(text).not.toContain("%");
  });
});
