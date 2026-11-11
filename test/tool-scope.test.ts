import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, agentToolResults, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

describe("durable built-in tool scope", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it.each([
    { type: "Explore", frontmatter: undefined, canWrite: false },
    { type: "Plan", frontmatter: undefined, canWrite: false },
    { type: "scoped", frontmatter: "tools: read, bash", canWrite: false },
    { type: "scoped", frontmatter: "disallowedTools: write, edit", canWrite: false },
    { type: "general-purpose", frontmatter: undefined, canWrite: true },
  ])("honors $type ($frontmatter)", async ({ type, frontmatter, canWrite }) => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-tool-scope-"));
    const written = join(cwd, "written.txt");
    const edited = join(cwd, "edited.txt");
    writeFileSync(edited, "original");
    if (frontmatter) {
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "agents", "scoped.md"), `---\ndescription: Scoped agent.\n${frontmatter}\n---\nCheck tools.\n`);
    }
    const offered: string[][] = [];
    const results: Array<{ toolName: string; isError?: boolean }> = [];
    run = await runPrintMode({
      prompt: "Delegate the tool check.",
      cwd,
      live: false,
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: type, description: "scope", prompt: "Check tools.", run_in_background: false }),
        subagent: (ctx) => {
          offered.push(getCurrentTools(ctx.messages).map((tool) => tool.name));
          const toolResults = ctx.messages.filter((message) => message.role === "toolResult");
          if (!toolResults.some((message) => message.toolName === "write"))
            return fauxToolCall("write", { path: written, content: "created" });
          if (!toolResults.some((message) => message.toolName === "edit"))
            return fauxToolCall("edit", { path: edited, edits: [{ oldText: "original", newText: "changed" }] });
          results.push(...toolResults.map((message) => ({ toolName: message.toolName, isError: message.isError })));
          return "Scope checked.";
        },
      }),
    });
    expect(agentToolResults(run.parentSession).join("\n")).toContain("Scope checked.");
    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) {
      expect(names).toContain("read");
      expect(names).toContain("bash");
      expect(names.includes("write")).toBe(canWrite);
      expect(names.includes("edit")).toBe(canWrite);
    }
    expect(results.filter((result) => ["write", "edit"].includes(result.toolName))).toEqual([
      { toolName: "write", isError: !canWrite },
      { toolName: "edit", isError: !canWrite },
    ]);
    expect(existsSync(written)).toBe(canWrite);
    expect(readFileSync(edited, "utf8")).toBe(canWrite ? "changed" : "original");
  });
});
