import { abortable } from "../abortable.js";
import type { AgentRecord } from "../types.js";

/** Wait through queueing and asynchronous startup without cancelling the run. */
export async function waitForRecord(record: AgentRecord, signal?: AbortSignal): Promise<void> {
  while (record.status === "queued" || (record.status === "running" && !record.promise)) {
    await abortable(new Promise<void>(resolve => setTimeout(resolve, 50)), signal);
  }
  if (record.promise && record.status !== "paused") await abortable(record.promise, signal);
}

export function consumeTerminalResult(record: AgentRecord): void {
  if (record.status !== "running" && record.status !== "queued" && record.status !== "paused") {
    record.resultConsumed = true;
  }
}
