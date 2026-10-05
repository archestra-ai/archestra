import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { agentRunReconciler } from "./reconciler";

describe("AgentRunReconciler", () => {
  afterEach(() => vi.restoreAllMocks());

  test("coalesces overlapping reconciliation ticks", async () => {
    vi.spyOn(AgentWorkspaceModel, "listForReaping").mockResolvedValue([]);
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

    const first = agentRunReconciler.reconcile();
    const overlapping = agentRunReconciler.reconcile();

    await overlapping;
    await expect.poll(() => listOpenSpy.mock.calls.length).toBe(1);
    expect(pendingSpy).not.toHaveBeenCalled();

    releaseListOpen?.([]);
    await first;
    expect(pendingSpy).toHaveBeenCalledOnce();
  });
});
