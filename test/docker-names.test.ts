import { describe, expect, it } from "vitest";
import { generateDockerName } from "../src/docker-names.js";

describe("generateDockerName", () => {
  it("generates a two-word lowercase hyphenated name", () => {
    const name = generateDockerName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("avoids taken names", () => {
    const taken = new Set(["bold-curie", "clever-hopper"]);
    for (let i = 0; i < 50; i++) {
      const name = generateDockerName(taken);
      expect(taken.has(name)).toBe(false);
    }
  });

  it("appends numerical suffix if candidate collisions persist", () => {
    const mockTaken = {
      has: (candidate: string) => !candidate.endsWith("-2"),
    } as unknown as Set<string>;

    const name = generateDockerName(mockTaken);
    expect(name).toMatch(/^[a-z]+-[a-z]+-2$/);
  });
});
