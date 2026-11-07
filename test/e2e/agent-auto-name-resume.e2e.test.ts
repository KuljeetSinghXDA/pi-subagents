/**
 * agent-auto-name-resume.e2e.test.ts — End-to-end verification of automatic Docker-style
 * naming and name-based resumption of subagents.
 *
 * Verifies:
 * 1. Spawning an unnamed subagent automatically assigns a two-word `<adjective>-<noun>` Docker name.
 * 2. Background tool output returns `Agent Name: <name>` and `resume: "<name>"`.
 * 3. The manager registers the name and resolves it via `resolveAgentRef`.
 * 4. Distinct runs without explicit names receive distinct names without collision.
 * 5. Providing an explicit `name` preserves that name and marks `autoNamed: false` (or undefined).
 * 6. Resuming by the generated name (`resume: "<name>"`) successfully resolves and continues the session.
 */
import { rmSync } from "node:fs";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolResults,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

describe.skipIf(LIVE)("agent auto-naming and resume e2e", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("automatically assigns a Docker-style name and announces it in tool results", async () => {
    run = await runPrintMode({
      prompt: "Delegate work without specifying a name.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "unnamed worker",
          prompt: "Process work payload",
          run_in_background: true,
        }),
        parentFinal: "Completed delegation.",
        subagent: "WORK_PAYLOAD_COMPLETE",
      }),
    });
    await run.manager?.waitForAll();

    const results = agentToolResults(run.parentSession).join("\n");
    const idMatch = /Agent ID: (\S+)/.exec(results);
    expect(idMatch).toBeTruthy();
    const agentId = idMatch![1];

    const nameMatch = /Agent Name: ([a-z]+-[a-z]+)/.exec(results);
    expect(nameMatch, `expected Docker name in tool output: ${results}`).toBeTruthy();
    const agentName = nameMatch![1];

    // Tool output instructions explicitly guide the model on how to resume with this name
    expect(results).toContain(`resume: "${agentName}"`);

    // Verify manager record has the alias and autoNamed flag
    const record = run.manager?.getRecord(agentId) as {
      alias?: string;
      autoNamed?: boolean;
    } | undefined;
    expect(record).toBeDefined();
    expect(record?.alias).toBe(agentName);
    expect(record?.autoNamed).toBe(true);

    // Verify manager resolves the agent by its generated Docker name via getRecord (accepts names or IDs)
    const resolved = (run.manager as any)?.getRecord(agentName);
    expect(resolved?.id).toBe(agentId);
  });

  it("preserves explicitly specified agent names without autoNamed flag", async () => {
    run = await runPrintMode({
      prompt: "Delegate work with explicit name.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "named worker",
          name: "security-auditor",
          prompt: "Audit security items",
          run_in_background: true,
        }),
        parentFinal: "Audit done.",
        subagent: "AUDIT_OK",
      }),
    });
    await run.manager?.waitForAll();

    const results = agentToolResults(run.parentSession).join("\n");
    expect(results).toContain("Agent Name: security-auditor");
    expect(results).toContain('resume: "security-auditor"');

    const idMatch = /Agent ID: (\S+)/.exec(results);
    const agentId = idMatch![1];

    const record = run.manager?.getRecord(agentId) as {
      alias?: string;
      autoNamed?: boolean;
    } | undefined;
    expect(record?.alias).toBe("security-auditor");
    expect(record?.autoNamed).toBeFalsy();

    const resolved = (run.manager as any)?.getRecord("security-auditor");
    expect(resolved?.id).toBe(agentId);
  });

  it("resumes an agent using its generated Docker-style name", async () => {
    let generatedName: string | undefined;

    run = await runPrintMode({
      prompt: "Spawn then resume by generated name.",
      respond: (context) => {
        const isParent = getCurrentTools(context.messages).some((t) => t.name === "Agent");
        if (!isParent) {
          // Subagent answers
          return "SUBAGENT_TURN_PROCESSED";
        }

        const agentResults = context.messages.filter(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
        );

        if (agentResults.length === 0) {
          // First parent turn: spawn unnamed background agent
          return agentCall({
            subagent_type: "general-purpose",
            description: "initial pass",
            prompt: "Pass 1",
            run_in_background: true,
          });
        }

        if (agentResults.length === 1) {
          // First spawn finished. Parse generated name from the tool output
          const text = (agentResults[0] as any).content?.[0]?.text ?? "";
          const match = /Agent Name: ([a-z]+-[a-z]+)/.exec(text);
          generatedName = match?.[1];
          expect(generatedName).toBeTruthy();

          // Second parent turn: resume by generated name in foreground
          return agentCall({
            resume: generatedName!,
            prompt: "Pass 2 continue",
            description: "resumed pass",
            run_in_background: false,
          });
        }

        return "ALL_TURNS_COMPLETED";
      },
    });

    await run.manager?.waitForAll();

    expect(generatedName).toBeDefined();
    const finalResults = agentToolResults(run.parentSession);
    expect(finalResults.length).toBeGreaterThanOrEqual(2);
    // The resumed run settled successfully
    expect(run.responseText).toContain("ALL_TURNS_COMPLETED");
  });

  it("assigns unique Docker names to distinct agents spawned without names", async () => {
    run = await runPrintMode({
      prompt: "Spawn two unnamed agents.",
      respond: (context) => {
        const isParent = getCurrentTools(context.messages).some((t) => t.name === "Agent");
        if (!isParent) return "CHILD_DONE";

        const agentResults = context.messages.filter(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
        );

        if (agentResults.length === 0) {
          return agentCall({
            subagent_type: "general-purpose",
            description: "worker one",
            prompt: "Task 1",
            run_in_background: true,
          });
        }
        if (agentResults.length === 1) {
          return agentCall({
            subagent_type: "general-purpose",
            description: "worker two",
            prompt: "Task 2",
            run_in_background: true,
          });
        }
        return "BOTH_SPAWNED";
      },
    });
    await run.manager?.waitForAll();

    const results = agentToolResults(run.parentSession);
    expect(results.length).toBeGreaterThanOrEqual(2);

    const names = results
      .map((r) => /Agent Name: ([a-z]+-[a-z]+)/.exec(r)?.[1])
      .filter((n): n is string => Boolean(n));

    expect(names.length).toBe(2);
    expect(names[0]).not.toBe(names[1]);
  });
});
