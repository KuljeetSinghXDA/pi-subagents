import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowControl,
  type WorkflowGateResult,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";
import { createWorkflowTask, updateWorkflowProgressBatch } from "../src/workflow/task.js";
import { ctx } from "./helpers/boot-extension.js";

const HEAD = 'export const meta = { name: "reliability", description: "regression checks" };\n';
const run = (body: string, options: Omit<RunWorkflowOptions, "script">) =>
  runWorkflow({ script: HEAD + body, ...options });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("workflow accounting and controls", () => {
  beforeEach(() => registerAgents(new Map()));

  it("counts only new output when the host resumes the same record", async () => {
    const record = {
      id: "child",
      type: "general-purpose",
      description: "test",
      status: "completed",
      result: "done",
      toolUses: 2,
      startedAt: 0,
      compactionCount: 0,
      lifetimeUsage: { input: 0, output: 100, cacheWrite: 0 },
    } as AgentRecord;
    const manager = {
      getRecord: () => record,
      async spawnAndWait(
        _pi: unknown, _ctx: unknown, _type: string, _prompt: string,
        _options: unknown, onSpawned?: (id: string) => void,
      ) {
        onSpawned?.(record.id);
        return { id: record.id, record };
      },
      async resume() {
        record.lifetimeUsage.output += 50;
        record.toolUses += 1;
        return record;
      },
      abort: vi.fn(),
    } as unknown as AgentManager;
    const host = createWorkflowHost({ pi: {} as ExtensionAPI, ctx: ctx(), manager });
    const task = createWorkflowTask({ id: "wf_usage", script: "" });
    const result = await run(
      'await agent("first", { label: "one" }); await agent("second", { resume: "one" }); return budget.spent();',
      { host, onProgress: entries => updateWorkflowProgressBatch(task, entries) },
    );
    expect(result.status).toBe("completed");
    expect(result.value).toBe(150);
    const entries = result.progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");
    expect(entries.at(-1)?.tokens).toBe(50);
    expect(task.totalTokens).toBe(150);
    expect(task.totalToolCalls).toBe(3);
  });

  it("counts output spent by an attempt the user retries", async () => {
    const started = deferred<void>();
    const first = deferred<WorkflowSpawnResult>();
    let attempts = 0;
    let control!: WorkflowControl;
    const done = run('await agent("test"); return budget.spent();', {
      onControl: value => { control = value; },
      host: {
        async spawnAgent() {
          if (++attempts === 1) {
            started.resolve();
            return first.promise;
          }
          return { ok: true, text: "done", outputTokens: 50, tokens: 60, toolCalls: 1 };
        },
        abortAgent() { first.resolve({ ok: false, error: "stopped", outputTokens: 100, tokens: 120, toolCalls: 2 }); },
      },
    });
    await started.promise;
    expect(control.retry(0)).toBe(true);
    const result = await done;
    expect(result.status).toBe("completed");
    expect(result.value).toBe(150);
    expect(attempts).toBe(2);
    const entries = result.progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");
    expect(entries.at(-1)).toMatchObject({ tokens: 180, toolCalls: 3 });
  });

  it("retains earlier retry usage when skipped before the next attempt starts", async () => {
    const started = deferred<void>();
    const first = deferred<WorkflowSpawnResult>();
    const task = createWorkflowTask({ id: "wf_skip_retry", script: "" });
    let control!: WorkflowControl;
    let skipped = false;
    const done = run('await agent("test"); return budget.spent();', {
      onControl: value => { control = value; },
      onProgress: entries => {
        updateWorkflowProgressBatch(task, entries);
        if (!skipped && entries.some(entry => entry.type === "workflow_agent" && entry.attempt === 2)) {
          skipped = true;
          expect(control.skip(0)).toBe(true);
        }
      },
      host: {
        async spawnAgent() { started.resolve(); return first.promise; },
        abortAgent() { first.resolve({ ok: false, error: "stopped", outputTokens: 100, tokens: 120, toolCalls: 2 }); },
      },
    });
    await started.promise;
    expect(control.retry(0)).toBe(true);
    const result = await done;
    expect(result.status).toBe("completed");
    expect(result.value).toBe(100);
    expect(task.totalTokens).toBe(120);
    expect(task.totalToolCalls).toBe(2);
  });

  it.each([true, false])("honors skip during verification when the command succeeds=%s", async ok => {
    const started = deferred<void>();
    const gate = deferred<WorkflowGateResult>();
    let control!: WorkflowControl;
    const done = run('const answer = await agent("test", { gate: "check" }); return {answer, spent: budget.spent()};', {
      onControl: value => { control = value; },
      host: {
        async spawnAgent() { return { ok: true, text: "done", outputTokens: 20 }; },
        abortAgent: vi.fn(),
        async runGate() { started.resolve(); return gate.promise; },
      },
    });
    await started.promise;
    expect(control.skip(0)).toBe(true);
    gate.resolve({ ok, output: ok ? "" : "verification failed" });
    const result = await done;
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ answer: null, spent: 20 });
    const entries = result.progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");
    expect(entries.at(-1)).toMatchObject({ state: "error", skipped: true });
  });

  it("keeps agent usage and tool counts when verification throws", async () => {
    const result = await run('await agent("test", { gate: "check" }); return budget.spent();', {
      host: {
        async spawnAgent() { return { ok: true, text: "done", outputTokens: 100, tokens: 120, toolCalls: 3 }; },
        abortAgent: vi.fn(),
        async runGate() { throw new Error("spawn ENOENT"); },
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe(100);
    const entries = result.progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");
    expect(entries.at(-1)).toMatchObject({ state: "error", error: "spawn ENOENT", tokens: 120, toolCalls: 3 });
  });
});
