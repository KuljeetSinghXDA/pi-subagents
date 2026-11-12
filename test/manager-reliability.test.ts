import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(), resumeAgent: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: () => true,
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createAskAnswerTools, createNestedSubagentTools } from "../src/nested-tools.js";
import { createGetResultTool } from "../src/tools/inspect-tools.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const pi = {} as any;
const ctx = { cwd: "/tmp" } as any;
const session = () => ({ steer: vi.fn(async () => {}), dispose: vi.fn() }) as any;
const outcome = () => ({ responseText: "done", session: session(), aborted: false, steered: false });
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let manager: AgentManager;
beforeEach(() => { vi.resetAllMocks(); manager = new AgentManager(undefined, 1); });
afterEach(async () => { await manager.dispose(); });

async function paused() {
  const run = deferred<any>();
  vi.mocked(runAgent).mockReturnValueOnce(run.promise);
  const id = manager.spawn(pi, ctx, "X", "go", { description: "paused", isBackground: true });
  const record = manager.getRecord(id)!;
  record.session = session();
  await manager.awaitStartup(id);
  expect(manager.pause(id)).toBe(true);
  return { id, record, run };
}

describe("manager reliability regressions", () => {
  it("drops pending parent questions when the initial run rejects", async () => {
    const run = deferred<Awaited<ReturnType<typeof runAgent>>>();
    vi.mocked(runAgent).mockReturnValueOnce(run.promise);
    const id = manager.spawn(pi, ctx, "X", "go", { description: "questioner", isBackground: true });
    const record = manager.getRecord(id)!;
    const [ask] = createAskAnswerTools({ manager, pi: { sendMessage: vi.fn() } as any, parentAgentId: id });
    await ask.execute("ask", { question: "Which module?" }, undefined, undefined, ctx);
    expect(record.questions?.[0].state).toBe("delivered");

    run.reject(new Error("provider failed"));
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.questions?.[0].state).toBe("dropped");
    const result = await createGetResultTool({
      resolveAgentRef: () => record, resolveMention: () => undefined,
      isShowCostEnabled: () => false, outbox: { cancel: vi.fn() }, pi,
    } as any).execute("result", { agent_id: id }, undefined, undefined, ctx);
    expect(result.content[0]).toEqual(expect.objectContaining({ text: expect.not.stringContaining("[QUESTION for you") }));
  });

  it("includes nested resume spend in every ancestor's total", async () => {
    const topRun = deferred<Awaited<ReturnType<typeof runAgent>>>();
    const middleRun = deferred<Awaited<ReturnType<typeof runAgent>>>();
    vi.mocked(runAgent).mockReturnValueOnce(topRun.promise).mockReturnValueOnce(middleRun.promise).mockResolvedValueOnce(outcome());
    const topId = manager.spawn(pi, ctx, "X", "go", { description: "top", isBackground: true });
    const middleId = manager.spawn(pi, ctx, "X", "go", { description: "middle", parentAgentId: topId });
    const child = await manager.spawnAndWait(pi, ctx, "X", "go", { description: "child", parentAgentId: middleId });
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session, _prompt, options) => {
      options!.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 1, cacheRead: 2, cost: 0.25 });
      return { text: "continued", aborted: false, steered: false };
    });
    const [agent] = createNestedSubagentTools({
      manager, pi, parentAgentId: middleId, depth: 2, maxSubagentDepth: 3,
      allowedSubagents: "all", configCwd: ctx.cwd,
    });
    await agent.execute("resume", {
      resume: child.id, prompt: "Continue", description: "continue", subagent_type: "X",
    }, undefined, undefined, ctx);

    for (const id of [child.id, middleId, topId]) {
      expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1, cacheRead: 2, cost: 0.25 });
    }
    middleRun.resolve(outcome());
    await manager.getRecord(middleId)!.promise;
    topRun.resolve(outcome());
    await manager.getRecord(topId)!.promise;
  });

  it("returns promptly from background gate resume and sends its prompt", async () => {
    const { id, record, run } = await paused();
    let returned = false;
    const resumed = manager.resume(id, "more", undefined, { isBackground: true }).then(() => { returned = true; });
    await tick();
    expect(returned).toBe(true);
    expect(record.session!.steer).toHaveBeenCalledWith("more");
    run.resolve(outcome());
    await resumed;
    await record.promise;
  });

  it("waits on repeated foreground resume while gate reopening is queued", async () => {
    const { id, record, run } = await paused();
    const blocker = deferred<any>();
    vi.mocked(runAgent).mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(pi, ctx, "X", "block", { description: "block", isBackground: true });
    await manager.resume(id, "first", undefined, { isBackground: true });
    let returned = false;
    const resumed = manager.resume(id, "second").then(() => { returned = true; });
    await tick();
    expect(returned).toBe(false);
    blocker.resolve(outcome());
    await manager.getRecord(blockerId)!.promise;
    await tick();
    expect(record.status).toBe("running");
    expect(returned).toBe(false);
    run.resolve(outcome());
    await resumed;
    expect(record.resultConsumed).toBe(true);
  });

  it.each([false, true])("cancels a foreground gate wait (queued=%s)", async (queued) => {
    const { id, record, run } = await paused();
    if (queued) {
      vi.mocked(runAgent).mockReturnValueOnce(new Promise(() => {}));
      manager.spawn(pi, ctx, "X", "block", { description: "block", isBackground: true });
    }
    const controller = new AbortController();
    const resumed = manager.resume(id, "more", controller.signal);
    const rejection = expect(resumed).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejection;
    expect(record.abortController!.signal.aborted).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.resultConsumed).not.toBe(true);
    run.resolve(outcome());
    await record.promise;
  });

  it("marks a detached startup failure terminal and drains after a throwing callback", async () => {
    const copy = deferred<any>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    await manager.dispose();
    manager = new AgentManager(() => { throw new Error("listener broke"); }, 1);
    const id = manager.spawn(pi, ctx, "X", "copy", { description: "copy", isBackground: true, isolation: "worktree" });
    const record = manager.getRecord(id)!;
    vi.mocked(runAgent).mockResolvedValue(outcome());
    const next = manager.spawn(pi, ctx, "X", "next", { description: "next", isBackground: true });
    const getResult = createGetResultTool({
      resolveAgentRef: () => record, resolveMention: () => undefined,
      isShowCostEnabled: () => false, outbox: { cancel: vi.fn() }, pi,
    } as any);
    let fetched = false;
    const result = getResult.execute("fetch", { agent_id: id, wait: true }, undefined, undefined, ctx)
      .then(value => { fetched = true; return value; });
    await tick();
    expect(fetched).toBe(false);
    const startup = expect(manager.awaitStartup(id)).rejects.toThrow("copy failed");
    copy.reject(new Error("copy failed"));
    await startup;
    await manager.waitForAll();
    expect(record.status).toBe("error");
    expect((await result).content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("copy failed") }));
    expect(manager.getRecord(next)!.status).toBe("completed");
    report.mockRestore();
  });

  it("drains after queued startup failure even when onComplete throws", async () => {
    const first = deferred<any>();
    vi.mocked(runAgent).mockReturnValueOnce(first.promise).mockResolvedValue(outcome());
    vi.mocked(createWorktree).mockRejectedValueOnce(new Error("copy failed"));
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    await manager.dispose();
    manager = new AgentManager(() => { throw new Error("listener broke"); }, 1);
    const firstId = manager.spawn(pi, ctx, "X", "first", { description: "first", isBackground: true });
    const bad = manager.spawn(pi, ctx, "X", "bad", { description: "bad", isBackground: true, isolation: "worktree" });
    const last = manager.spawn(pi, ctx, "X", "last", { description: "last", isBackground: true });
    first.resolve(outcome());
    await manager.getRecord(firstId)!.promise;
    await manager.waitForAll();
    expect(manager.getRecord(bad)!.status).toBe("error");
    expect(manager.getRecord(last)!.status).toBe("completed");
    report.mockRestore();
  });

  it.each([false, true])("preserves terminal status when worktree cleanup throws (failed=%s)", async (failed) => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createWorktree).mockResolvedValueOnce({ path: "/wt/copy", branch: "b", baseSha: "abc", workPath: "/wt/copy" });
    vi.mocked(cleanupWorktree).mockRejectedValue(new Error("cleanup broke"));
    if (failed) vi.mocked(runAgent).mockRejectedValueOnce(new Error("run broke"));
    else vi.mocked(runAgent).mockResolvedValueOnce(outcome());
    const id = manager.spawn(pi, ctx, "X", "go", { description: "go", isBackground: true, isolation: "worktree" });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    await expect(record.promise).resolves.toBe(failed ? "" : "done");
    expect(record.status).toBe(failed ? "error" : "completed");
    expect(record.error).toBe(failed ? "run broke" : undefined);
    expect(manager.runningBackground).toBe(0);
    expect(report).toHaveBeenCalled();
    report.mockRestore();
  });

  it("reaps never-started agents after individual abort and abortAll", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}));
    manager.spawn(pi, ctx, "X", "block", { description: "block", isBackground: true });
    const a = manager.spawn(pi, ctx, "X", "a", { description: "a", isBackground: true });
    const b = manager.spawn(pi, ctx, "X", "b", { description: "b", isBackground: true });
    manager.abort(a);
    manager.abortAll();
    for (const id of [a, b]) {
      const record = manager.getRecord(id)!;
      expect(record.resultConsumed).toBe(true);
      record.completedAt = 0;
    }
    (manager as any).cleanup();
    expect(manager.getRecord(a)).toBeUndefined();
    expect(manager.getRecord(b)).toBeUndefined();
  });

  it("installs the foreground resume promise, consumes output, and rejects a concurrent resume", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(outcome());
    const id = manager.spawn(pi, ctx, "X", "go", { description: "go", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    const oldPromise = record.promise;
    const run = deferred<any>();
    vi.mocked(resumeAgent).mockReturnValueOnce(run.promise);
    const resumed = manager.resume(id, "continue");
    expect(record.promise).not.toBe(oldPromise);
    await expect(manager.resume(id, "race")).rejects.toThrow("still running");
    run.resolve({ text: "new", aborted: false, steered: false });
    await resumed;
    expect(await record.promise).toBe("new");
    expect(record.resultConsumed).toBe(true);
  });

  it("drains run-error and background-resume completion paths after callback errors", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    await manager.dispose();
    manager = new AgentManager(() => { throw new Error("listener broke"); }, 1, () => { throw new Error("start listener broke"); });
    const first = deferred<any>();
    vi.mocked(runAgent).mockReturnValueOnce(first.promise).mockResolvedValue(outcome());
    const a = manager.spawn(pi, ctx, "X", "a", { description: "a", isBackground: true });
    const b = manager.spawn(pi, ctx, "X", "b", { description: "b", isBackground: true });
    first.reject(new Error("run broke"));
    await manager.getRecord(a)!.promise;
    await manager.waitForAll();
    expect(manager.getRecord(a)!.status).toBe("error");
    expect(manager.getRecord(b)!.status).toBe("completed");
    const continuation = deferred<any>();
    vi.mocked(resumeAgent).mockReturnValueOnce(continuation.promise);
    await manager.resume(b, "continue", undefined, { isBackground: true });
    const c = manager.spawn(pi, ctx, "X", "c", { description: "c", isBackground: true });
    continuation.reject(new Error("resume broke"));
    await manager.getRecord(b)!.promise;
    await manager.waitForAll();
    expect(manager.getRecord(b)!.status).toBe("error");
    expect(manager.getRecord(c)!.status).toBe("completed");
    expect(manager.runningBackground).toBe(0);
    report.mockRestore();
  });

  it("deduplicates stable toolCallId counts across spawn and resume", async () => {
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onToolActivity!({ type: "end", toolName: "read", toolCallId: "one" });
      options.onToolActivity!({ type: "end", toolName: "read", toolCallId: "one" });
      return outcome();
    });
    const { id, record } = await manager.spawnAndWait(pi, ctx, "X", "go", { description: "go" });
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session: any, _prompt: any, options: any) => {
      options.onToolActivity({ type: "end", toolName: "read", toolCallId: "one" });
      options.onToolActivity({ type: "end", toolName: "read", toolCallId: "one" });
      return { text: "done", aborted: false, steered: false };
    });
    await manager.resume(id, "more");
    expect(record.toolUses).toBe(2);
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session: any, _prompt: any, options: any) => {
      options.onToolActivity({ type: "end", toolName: "read", toolCallId: "one" });
      options.onToolActivity({ type: "end", toolName: "read", toolCallId: "one" });
      return { text: "done", aborted: false, steered: false };
    });
    await manager.resume(id, "background", undefined, { isBackground: true });
    await record.promise;
    expect(record.toolUses).toBe(3);
  });
});
