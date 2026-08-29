import { vi } from "vitest";
import { AgentRunModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { agentExecutionReconciler } from "./reconciler";

describe("AgentExecutionReconciler", () => {
  afterEach(() => vi.restoreAllMocks());

  test("coalesces overlapping reconciliation ticks", async () => {
    let releaseListOpen: ((sessions: never[]) => void) | undefined;
    const listOpen = new Promise<never[]>((resolve) => {
      releaseListOpen = resolve;
    });
    const listOpenSpy = vi
      .spyOn(AgentRunModel, "listOpen")
      .mockReturnValue(listOpen);
    const pendingSpy = vi
      .spyOn(AgentRunModel, "listPendingCompletionNotifications")
      .mockResolvedValue([]);

    const first = agentExecutionReconciler.reconcile();
    const overlapping = agentExecutionReconciler.reconcile();

    await overlapping;
    expect(listOpenSpy).toHaveBeenCalledOnce();
    expect(pendingSpy).not.toHaveBeenCalled();

    releaseListOpen?.([]);
    await first;
    expect(pendingSpy).toHaveBeenCalledOnce();
  });
});
