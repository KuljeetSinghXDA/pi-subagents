/**
 * durable-runner.ts — Execution engine backed by @earendil-works/pi-durable.
 *
 * Provides transactional, crash-resilient subagent runs with native task ownership,
 * dependency waiting, and replay-safe execution.
 */

export { runAgent as runDurableAgent } from "./runner-session.js";
export type { RunOptions as DurableRunOptions } from "./runner-types.js";
