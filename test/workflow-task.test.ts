/**
 * workflow-task.test.ts — the record one run lives in.
 *
 * Most of `task.ts` is covered through the tool and command suites, which drive
 * it the way the extension does. The pause bookkeeping is not: it is a small
 * state machine that spans the record and the run's control surface, and the
 * two ways it can go wrong — flipping the record without telling the runtime,
 * or letting a held run keep counting elapsed time — are both invisible from
 * the outside. So it gets driven directly, against a control stub.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collapse, type WorkflowEntry } from "../src/workflow/progress.js";
import type { WorkflowControl } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  formatWorkflowNotification,
  pauseWorkflowTask,
  resumeWorkflowTask,
  updateWorkflowProgressBatch,
  WORKFLOW_NOTIFICATION_RESULT_CAP,
  type WorkflowTask,
} from "../src/workflow/task.js";

function stubControl(): WorkflowControl & { pause: ReturnType<typeof vi.fn> } {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
  } as unknown as WorkflowControl & { pause: ReturnType<typeof vi.fn> };
}

function runningTask(): { task: WorkflowTask; control: ReturnType<typeof stubControl> } {
  const task = createWorkflowTask({ id: "wf_abc123", script: "", startTime: 1_000 });
  const control = stubControl();
  task.control = control;
  return { task, control };
}

describe("pausing a run", () => {
  it("tells the run to hold, not just the record", () => {
    // Flipping the status alone would show a paused run in every surface while
    // it kept starting agents.
    const { task, control } = runningTask();

    expect(pauseWorkflowTask(task, 5_000)).toBe(true);
    expect(control.pause).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBe(5_000);
  });

  it("banks the held time on resume, so elapsed does not count it", () => {
    const { task, control } = runningTask();
    pauseWorkflowTask(task, 5_000);

    expect(resumeWorkflowTask(task, 9_000)).toBe(true);
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("running");
    expect(task.totalPausedMs).toBe(4_000);
    expect(task.pausedAt).toBeUndefined();
  });

  it("accumulates across several pauses", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task, 2_000);
    resumeWorkflowTask(task, 3_000);
    pauseWorkflowTask(task, 4_000);
    resumeWorkflowTask(task, 10_000);

    expect(task.totalPausedMs).toBe(7_000);
  });

  it("refuses when there is no run behind the record", () => {
    // A task whose run has settled keeps its progress but loses its control;
    // pausing it would be a status the runtime never agreed to.
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    expect(pauseWorkflowTask(task)).toBe(false);
    expect(task.status).toBe("running");
  });

  it("refuses to pause twice or resume something running", () => {
    const { task, control } = runningTask();
    expect(pauseWorkflowTask(task, 1_000)).toBe(true);
    expect(pauseWorkflowTask(task, 2_000)).toBe(false);
    expect(control.pause).toHaveBeenCalledTimes(1);
    // And the first pause's clock is untouched by the refused second one.
    expect(task.pausedAt).toBe(1_000);

    expect(resumeWorkflowTask(task, 3_000)).toBe(true);
    expect(resumeWorkflowTask(task, 4_000)).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });
});

describe("settling a run", () => {
  const result = {
    status: "completed" as const,
    value: 1,
    meta: { name: "wf", description: "d" },
    progress: [],
    agentCount: 0,
    replayedCount: 0,
  };

  it("drops the control so a finished run cannot be paused", () => {
    const { task } = runningTask();
    completeWorkflowTask(task, result);

    expect(task.control).toBeUndefined();
    expect(pauseWorkflowTask(task)).toBe(false);
  });

  it("banks a pause that was still open when the run finished", () => {
    // A run held at a pause can still settle — its last agents finish and the
    // script returns. That time was spent held, and elapsed has to say so.
    const { task } = runningTask();
    pauseWorkflowTask(task, Date.now() - 3_000);
    completeWorkflowTask(task, result);

    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBeGreaterThanOrEqual(3_000);
    expect(task.status).toBe("completed");
  });

  it("drops the control when the run never started", () => {
    const { task } = runningTask();
    failWorkflowTask(task, "bad meta");

    expect(task.control).toBeUndefined();
    expect(task.status).toBe("failed");
  });
});

describe("formatWorkflowNotification", () => {
  it("reports agents, not row emissions, in the summary", () => {
    // Three agents × the lifecycle rows the runtime emits per agent. Counting
    // raw entries once read this as 3/10 (a real run read 5/25).
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    const entries: WorkflowEntry[] = [];
    for (let index = 0; index < 3; index++) {
      entries.push(
        { type: "workflow_agent", index, label: `agent-${index}`, phaseIndex: 0, state: "start", queuedAt: 5 },
        { type: "workflow_agent", index, label: `agent-${index}`, phaseIndex: 0, state: "progress", queuedAt: 5, startedAt: 6 },
        { type: "workflow_agent", index, label: `agent-${index}`, phaseIndex: 0, state: "done" },
      );
    }
    updateWorkflowProgressBatch(task, entries);
    completeWorkflowTask(task, {
      status: "completed",
      value: undefined,
      meta: { name: "probe", description: "d" },
      progress: [],
      agentCount: 3,
      replayedCount: 0,
    });

    expect(formatWorkflowNotification(task, 10_000)).toContain('completed — 3/3 agents');
  });
});

describe("a result the notification cannot carry", () => {
  const long = (marker: string) => `${marker}\n${"x".repeat(WORKFLOW_NOTIFICATION_RESULT_CAP)}${marker}-tail`;
  function settle(value: unknown, journalPath?: string): WorkflowTask {
    const task = createWorkflowTask({ id: "wf_capped", script: "", ...(journalPath !== undefined ? { journalPath } : {}) });
    completeWorkflowTask(task, {
      status: "completed",
      value,
      meta: { name: "probe", description: "d" },
      progress: [],
      agentCount: 0,
      replayedCount: 0,
    });
    return task;
  }
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wf-result-")); });
  it("writes the whole value beside the journal and names the file", () => {
    const journalPath = join(dir, "wf_capped.workflow.jsonl");
    const task = settle(long("HEAD"), journalPath);
    const expected = join(dir, "wf_capped.workflow.result.txt");
    expect(task.resultPath).toBe(expected);
    expect(readFileSync(expected, "utf-8")).toBe(`HEAD\n${"x".repeat(WORKFLOW_NOTIFICATION_RESULT_CAP)}HEAD-tail`);
    const notification = formatWorkflowNotification(task, 10_000);
    expect(notification).toContain("(truncated)");
    expect(notification).toContain(`<result-file>${expected}</result-file>`);
    // The head is still inline, so a caller that does not need the tail pays nothing.
    expect(notification).toContain("HEAD");
  });
  it("writes nothing for a result that fits", () => {
    const task = settle("short", join(dir, "wf_capped.workflow.jsonl"));
    expect(task.resultPath).toBeUndefined();
    expect(formatWorkflowNotification(task, 10_000)).not.toContain("<result-file>");
  });
  it("still settles when there is nowhere to write the file", () => {
    const task = settle(long("HEAD"));
    expect(task.resultPath).toBeUndefined();
    // Nothing to point at, so the marker alone has to say the tail is missing.
    expect(formatWorkflowNotification(task, 10_000)).toContain("(truncated)");
  });
  it("does not fail the run when the write is impossible", () => {
    const task = settle(long("HEAD"), join(dir, "missing", "wf_capped.workflow.jsonl"));
    expect(task.status).toBe("completed");
    expect(task.resultPath).toBeUndefined();
  });
});

describe("updateWorkflowProgressBatch", () => {
  const agent = (index: number, state: "start" | "done", tokens: number): WorkflowEntry => ({
    type: "workflow_agent",
    index,
    label: `a${index}`,
    state,
    tokens,
  });

  it("keeps one entry per agent however often a running row is re-emitted (#453)", () => {
    const task = createWorkflowTask({ id: "wf-1", script: "" });
    const all: WorkflowEntry[] = [];
    const apply = (entries: WorkflowEntry[]) => {
      all.push(...entries);
      updateWorkflowProgressBatch(task, entries);
    };

    apply([{ type: "workflow_phase", index: 0, title: "scan" }, agent(0, "start", 0), agent(1, "start", 0)]);
    // Two children interleaving live counter updates, as a fan-out does.
    for (let i = 1; i <= 50; i++) apply([agent(0, "start", i), agent(1, "start", i * 2)]);
    apply([{ type: "workflow_log", message: "halfway" }, agent(0, "done", 60), agent(1, "done", 120)]);

    expect(task.workflowProgress).toHaveLength(4);
    // Lossless for every reader: they all go through collapse.
    expect(collapse(task.workflowProgress)).toEqual(collapse(all));
    expect(task.totalTokens).toBe(180);
    expect(task.doneCount).toBe(2);
  });

  it("replaces in place, so the log keeps first-emission order and the slots stay valid", () => {
    const task = createWorkflowTask({ id: "wf-2", script: "" });
    updateWorkflowProgressBatch(task, [agent(1, "start", 5), agent(0, "start", 7)]);
    updateWorkflowProgressBatch(task, [agent(1, "done", 50)]);

    // Slot 0 belongs to index 1, slot 1 to index 0 — replaced where it was.
    expect(task.workflowProgress.map(e => (e.type === "workflow_agent" ? e.index : -1))).toEqual([1, 0]);
    expect(task.agentSlots.get(1)).toBe(0);
    expect(task.totalTokens).toBe(57);
    expect(task.doneCount).toBe(1);
  });
});
