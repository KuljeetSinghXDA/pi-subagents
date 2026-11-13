/**
 * agents-menu-dispatch.test.ts — `/agents` dispatches on each row's fixed
 * value, not on a substring of its label.
 *
 * Labels carry live counts ("Running agents (2) — 1 running, 1 done"), so
 * branching on a prefix makes a stale or renamed label reach a handler it was
 * never meant to name. The menu matches the label it produced, then switches on
 * the paired value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("/agents menu dispatch", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({});
  });
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic.restore();
  });

  it("ignores a label that only looks like one of its rows", async () => {
    const titles: string[] = [];
    const notify = vi.fn();
    const context = ctx({
      ui: {
        notify,
        // No running agents exist, so the menu has no such row. A label that
        // starts with the old prefix must not open the running list.
        select: vi.fn(async (title: string) => {
          titles.push(title);
          return titles.length === 1 ? "Running agents (99) — 99 running, 0 done" : undefined;
        }),
      },
    });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    await command.handler("", context);

    expect(titles).toEqual(["Agents"]);
    expect(notify).not.toHaveBeenCalledWith("No agents.", "info");
  });

  it("still opens the row whose label it produced", async () => {
    const selects: string[] = [];
    const context = ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          selects.push(title);
          // First menu: the Settings row. The settings page closes at once
          // via `custom`, and the reopened menu is answered with undefined.
          return selects.length === 1 ? options.find(option => option === "Settings") : undefined;
        }),
        custom: vi.fn(async () => undefined),
        input: vi.fn(async () => undefined),
      },
    });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    await command.handler("", context);

    expect(selects).toEqual(["Agents", "Agents"]);
  });
});
