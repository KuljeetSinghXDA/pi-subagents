import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { WorktreeCoordinator } from "../src/manager/worktree-coordinator.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree } from "../src/worktree.js";

vi.mock("../src/worktree.js", () => ({
  cleanupWorktree: vi.fn(),
  createWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(),
}));

it("shows the recovery path when preservation kept files without a branch", async () => {
  vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, path: "/retained/agent" });
  const record = {
    description: "fix",
    result: "Agent finished.",
    worktree: { path: "/retained/agent", workPath: "/retained/agent", branch: "pi-agent-test", baseSha: "base" },
  } as AgentRecord;
  await new WorktreeCoordinator().cleanup({} as ExtensionAPI, "/repo", record, {});
  expect(record.result).toContain("Agent finished.");
  expect(record.result).toContain("Automatic preservation failed");
  expect(record.result).toContain("/retained/agent");
  expect(record.result).not.toContain("Changes saved to branch");
});
