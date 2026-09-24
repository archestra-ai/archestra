import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  describeAgentRuntimeStartupProgress,
  isSameAgentRuntimeStartupProgress,
} from "./startup-phase";

describe("describeAgentRuntimeStartupProgress", () => {
  it("reports the run as queued before a pod carries it", () => {
    expect(describeAgentRuntimeStartupProgress(null)).toEqual({
      phase: "queued",
      message: "Waiting for the run to be scheduled",
      detail: null,
    });
  });

  it("surfaces why a pending pod cannot be placed", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/3 nodes are available: insufficient memory",
          },
        ],
      }),
    );

    expect(progress.phase).toBe("scheduling");
    expect(progress.detail).toBe(
      "Unschedulable: 0/3 nodes are available: insufficient memory",
    );
  });

  it("surfaces a failing image pull rather than presenting it as a normal wait", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        containerStatuses: [
          {
            state: {
              waiting: {
                reason: "ImagePullBackOff",
                message: 'Back-off pulling image "ghcr.io/example/agent:v9"',
              },
            },
          },
        ],
      }),
    );

    expect(progress.phase).toBe("pulling");
    expect(progress.detail).toBe(
      'ImagePullBackOff: Back-off pulling image "ghcr.io/example/agent:v9"',
    );
  });

  it("treats an ordinary container start as progress with nothing to explain", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        containerStatuses: [
          { state: { waiting: { reason: "ContainerCreating" } } },
        ],
      }),
    );

    expect(progress).toEqual({
      phase: "pulling",
      message: "Pulling the agent image",
      detail: null,
    });
  });

  it("waits on the agent session once the container is running", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({ phase: "Running" }),
    );

    expect(progress).toEqual({
      phase: "starting",
      message: "Waiting for the agent session",
      detail: null,
    });
  });

  it("does not report a crash-looping container as a healthy start", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Running",
        containerStatuses: [
          {
            state: {
              waiting: {
                reason: "CrashLoopBackOff",
                message: "back-off 40s restarting failed container",
              },
            },
          },
        ],
      }),
    );

    expect(progress.phase).toBe("starting");
    expect(progress.detail).toBe(
      "CrashLoopBackOff: back-off 40s restarting failed container",
    );
  });

  it("reads an init container's wait, which blocks the run just as much", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        initContainerStatuses: [
          {
            state: {
              waiting: { reason: "ErrImagePull", message: "manifest unknown" },
            },
          },
        ],
      }),
    );

    expect(progress.phase).toBe("pulling");
    expect(progress.detail).toBe("ErrImagePull: manifest unknown");
  });
});

describe("isSameAgentRuntimeStartupProgress", () => {
  it("suppresses a repeat of the poll's previous report", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({ phase: "Running" }),
    );
    expect(isSameAgentRuntimeStartupProgress(progress, { ...progress })).toBe(
      true,
    );
  });

  it("lets a changed reason through even when the phase has not moved", () => {
    const creating = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        containerStatuses: [
          { state: { waiting: { reason: "ContainerCreating" } } },
        ],
      }),
    );
    const backingOff = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        containerStatuses: [
          { state: { waiting: { reason: "ImagePullBackOff" } } },
        ],
      }),
    );

    expect(creating.phase).toBe(backingOff.phase);
    expect(isSameAgentRuntimeStartupProgress(creating, backingOff)).toBe(false);
  });

  it("always reports the first observation", () => {
    const progress = describeAgentRuntimeStartupProgress(null);
    expect(isSameAgentRuntimeStartupProgress(null, progress)).toBe(false);
  });
});

function pod(status: {
  phase?: string;
  conditions?: k8s.V1PodCondition[];
  containerStatuses?: Partial<k8s.V1ContainerStatus>[];
  initContainerStatuses?: Partial<k8s.V1ContainerStatus>[];
}): k8s.V1Pod {
  return {
    metadata: { name: "archestra-run-test" },
    status: {
      phase: status.phase,
      conditions: status.conditions,
      containerStatuses: status.containerStatuses as k8s.V1ContainerStatus[],
      initContainerStatuses:
        status.initContainerStatuses as k8s.V1ContainerStatus[],
    },
  } as k8s.V1Pod;
}
