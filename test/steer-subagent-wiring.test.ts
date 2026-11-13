/**
 * steer-subagent-wiring.test.ts — the steer_subagent path that can silently
 * swallow user input.
 *
 * A steer issued between spawn and session creation is parked on the record as
 * `pendingSteers` and flushed later by AgentManager. The tool tells the caller
 * the message was queued, so if the queue is dropped or overwritten the user is
 * told their correction landed when it never will. That whole branch had no
 * coverage. Workflow children accept steering by id, but nested children remain
 * under their parent's control.
 *
 * The plain rejections (unknown id, non-running status) are deliberately not
 * tested: they are single-line guards whose failure is immediately visible in
 * the tool's own reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent, steerAgent } from "../src/agent-runner.js";
import { CompletionOutbox } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { createSteerTool } from "../src/tools/inspect-tools.js";
import { createWorkflowTask } from "../src/workflow/task.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

// steerAgent and runAgent are module-level mocks shared by every case here, so
// call history has to be reset or a "was never called" assertion depends on the
// order the cases happen to run in.
beforeEach(() => {
  vi.mocked(steerAgent).mockReset();
  vi.mocked(runAgent).mockReset();
});

/** Enough of an AgentSession for the manager's and index's onSessionCreated hooks. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

/** A runAgent that never settles, and only creates its session when told to. */
function heldRun() {
  let createSession: ((session: any) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        createSession = (session: any) => opts.onSessionCreated?.(session);
      }) as any,
  );
  return {
    create(session: any) {
      createSession?.(session);
    },
  };
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "steer wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const steer = (tools: Map<string, any>, agent_id: string, message: string) =>
  tools.get("steer_subagent").execute("tc-steer", { agent_id, message }, undefined, undefined, ctx());
describe("steer_subagent workflow ownership", () => {
  it.each([false, true])("steers a workflow child with an initialized session: %s", async (initialized) => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();
    await spawnBackground(tools);
    const manager = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime!.manager;
    const id = manager.spawn(pi, ctx(), "general-purpose", "workflow task", {
      description: "workflow child",
      isBackground: true,
      workflowId: "wf_test",
    });
    await flush();
    const session = fakeSession();
    if (initialized) run.create(session);
    const result = await steer(tools, id, "refocus workflow task");
    expect(textOf(result)).toContain(initialized ? "Steering message sent" : "Steering message queued");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "refocus workflow task" });
    if (initialized) {
      expect(steerAgent).toHaveBeenCalledWith(session, "refocus workflow task");
    } else {
      run.create(session);
      await flush();
      expect(session.steer).toHaveBeenCalledWith("refocus workflow task");
    }
    expect(manager.getRecord(id)?.workflowId).toBe("wf_test");
    const read = await tools.get("get_subagent_result").execute(
      "tc-read", { agent_id: id }, undefined, undefined, ctx(),
    );
    expect(textOf(read)).toContain("Agent not found");
    await lifecycle.get("session_shutdown")?.();
  });
  it.each([undefined, "wf_test"])("rejects nested children with workflowId %s", async (workflowId) => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();
    const parentAgentId = await spawnBackground(tools);
    const manager = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime!.manager;
    const id = manager.spawn(pi, ctx(), "general-purpose", "nested task", {
      description: "nested child",
      isBackground: true,
      parentAgentId,
      workflowId,
    });
    await flush();
    const result = await steer(tools, id, "must not reach nested child");
    expect(textOf(result)).toContain("Agent not found");
    expect(manager.getRecord(id)?.pendingSteers).toBeUndefined();
    expect(steerAgent).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:steered", expect.objectContaining({ id }));
    await lifecycle.get("session_shutdown")?.();
  });
});

describe("steer_subagent workflow labels", () => {
  async function fixture() {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();
    const parentId = await spawnBackground(tools);
    const manager = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime!.manager;
    const id = manager.spawn(pi, ctx(), "general-purpose", "workflow task", {
      description: "review",
      isBackground: true,
      workflowId: "wf_test",
    });
    await flush();
    run.create(fakeSession());
    const task = createWorkflowTask({ id: "wf_test", script: "" });
    task.workflowProgress.push({ type: "workflow_agent", index: 0, label: "review", state: "start", recordId: id });
    const tool = createSteerTool({
      pi,
      resolveAgentRef: ref => manager.getRecord(ref),
      resolveMention: () => undefined,
      isShowCostEnabled: () => false,
      outbox: new CompletionOutbox(vi.fn(), () => false),
      workflowTasks: new Map([[task.id, task]]),
    });
    const send = (workflow_id = "wf_test", agent_id = "review") => tool.execute(
      "tc-label", { workflow_id, agent_id, message: "refocus review" }, undefined, undefined, ctx(),
    );
    return { manager, id, parentId, task, send, shutdown: () => lifecycle.get("session_shutdown")?.() };
  }
  it("resolves a script label using the returned workflow run ID", async () => {
    const f = await fixture();
    // Progress updates for one child must not make its label ambiguous.
    f.task.workflowProgress.push({ ...f.task.workflowProgress[0], state: "progress" });
    const result = await f.send();
    expect(textOf(result)).toContain(`Steering message sent to agent ${f.id}`);
    expect(steerAgent).toHaveBeenCalledWith(f.manager.getRecord(f.id)?.session, "refocus review");
    await f.shutdown();
  });
  it("rejects duplicate labels and returns exact IDs without sending", async () => {
    const f = await fixture();
    f.task.workflowProgress.push({ type: "workflow_agent", index: 1, label: "review", state: "start", recordId: "other-child" });
    const result = await f.send();
    expect(textOf(result)).toContain("Ambiguous workflow label");
    expect(textOf(result)).toContain(f.id);
    expect(textOf(result)).toContain("other-child");
    expect(steerAgent).not.toHaveBeenCalled();
    await f.shutdown();
  });
  it("reports a label that has not spawned yet instead of a cleaned-up agent", async () => {
    const f = await fixture();
    f.task.workflowProgress.push({ type: "workflow_agent", index: 1, label: "later", state: "start" });
    const result = await f.send("wf_test", "later");
    const text = textOf(result);
    expect(text).toContain("has not started yet");
    expect(text).not.toContain("cleaned up");
    expect(steerAgent).not.toHaveBeenCalled();
    await f.shutdown();
  });
  it("rejects duplicate labels when only one child has spawned", async () => {
    const f = await fixture();
    // The second `review` has a label but no recordId yet; it is still a duplicate.
    f.task.workflowProgress.push({ type: "workflow_agent", index: 1, label: "review", state: "start" });
    const result = await f.send();
    expect(textOf(result)).toContain("Ambiguous workflow label");
    expect(textOf(result)).toContain(f.id);
    expect(steerAgent).not.toHaveBeenCalled();
    await f.shutdown();
  });
  it("rejects unknown selectors, foreign records, nested children and finished children", async () => {
    const f = await fixture();
    expect(textOf(await f.send("wf_missing"))).toContain("Workflow not found");
    expect(textOf(await f.send("wf_test", "missing"))).toContain("Agent not found");
    const record = f.manager.getRecord(f.id)!;
    record.workflowId = "wf_other";
    expect(textOf(await f.send())).toContain("Agent not found");
    record.workflowId = "wf_test";
    record.parentAgentId = f.parentId;
    expect(textOf(await f.send())).toContain("Agent not found");
    record.parentAgentId = undefined;
    record.status = "completed";
    expect(textOf(await f.send())).toContain("not running");
    expect(steerAgent).not.toHaveBeenCalled();
    await f.shutdown();
  });
});
describe("steer_subagent before the session exists", () => {
  it("queues the message on the record and says so", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await steer(tools, id, "change course");
    expect(textOf(result)).toContain("queued");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "change course" });

    await lifecycle.get("session_shutdown")?.();
  });

  it("appends a second queued steer instead of replacing the first", async () => {
    // Overwriting would lose the earlier correction while still reporting success.
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();

    await steer(tools, id, "first");
    await steer(tools, id, "second");

    // Observe the queue through its only real consumer: the flush on session
    // creation, which must deliver both, in order.
    const sessionSteer = vi.fn().mockResolvedValue(undefined);
    run.create(fakeSession({ steer: sessionSteer }));
    await flush();

    expect(sessionSteer.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);

    await lifecycle.get("session_shutdown")?.();
  });

  it("does not call steerAgent — there is no session to steer yet", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();
    await steer(tools, id, "hello");

    expect(steerAgent).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("steer_subagent once the session exists", () => {
  it("reports failure and emits no event when the steer throws", async () => {
    // The event is emitted only AFTER steerAgent resolves, so a failed steer
    // must not announce itself as delivered.
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockRejectedValueOnce(new Error("session closed"));
    const result = await steer(tools, id, "too late");

    expect(textOf(result)).toContain("Failed to steer agent");
    expect(textOf(result)).toContain("session closed");
    expect(pi.events.emit).not.toHaveBeenCalledWith(
      "subagents:steered",
      expect.objectContaining({ message: "too late" }),
    );

    await lifecycle.get("session_shutdown")?.();
  });

  it("delivers through steerAgent and announces the steer on success", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    run.create(fakeSession());
    await flush();

    vi.mocked(steerAgent).mockResolvedValueOnce(undefined as any);
    const result = await steer(tools, id, "refocus");

    expect(steerAgent).toHaveBeenCalledWith(expect.anything(), "refocus");
    expect(textOf(result)).toContain("Steering message sent");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", { id, message: "refocus" });

    await lifecycle.get("session_shutdown")?.();
  });
});
