import { afterEach, describe, expect, test, vi } from "vitest";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import { AgentRunModel, AgentWorkspaceModel } from "@/models";
import { agentRunReconciler } from "./reconciler";

describe("AgentRunReconciler", () => {
  afterEach(() => vi.restoreAllMocks());

  test("idles until the cluster serves the Agent Sandbox API", async () => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(false);
    const reapSpy = vi
      .spyOn(AgentWorkspaceModel, "listForReaping")
      .mockResolvedValue([]);
    const listOpenSpy = vi
      .spyOn(AgentRunModel, "listOpen")
      .mockResolvedValue([]);

    await agentRunReconciler.reconcile();

    expect(reapSpy).not.toHaveBeenCalled();
    expect(listOpenSpy).not.toHaveBeenCalled();
  });

  test("coalesces overlapping reconciliation ticks", async () => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
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
