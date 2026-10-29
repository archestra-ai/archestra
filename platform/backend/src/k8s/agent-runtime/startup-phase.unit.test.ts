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

  it("explains a full cluster in plain words instead of the scheduler's message", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message:
              "0/17 nodes are available: 11 Insufficient memory, 12 Insufficient cpu, 5 node(s) didn't match Pod's node affinity/selector. preemption: 0/17 nodes are available: 12 No preemption victims found for incoming pod.",
          },
        ],
      }),
    );

    expect(progress.phase).toBe("scheduling");
    expect(progress.detail).toBe(
      "None of the 17 nodes has enough free CPU or memory right now. The run starts when other runs finish or the cluster adds a node.",
    );
  });

  it("still explains an unschedulable pod whose reason it does not recognize", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/3 nodes are available: 3 node(s) had untolerated taint",
          },
        ],
      }),
    );

    expect(progress.detail).toBe(
      "None of the 3 nodes can take this run yet. The run starts when the cluster has room for it.",
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

  it.for([
    ["ContainerCreating", "Preparing the agent container"],
    ["PodInitializing", "Preparing the Agent"],
  ])("describes %s without claiming an image download", ([reason, message]) => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        containerStatuses: [{ state: { waiting: { reason } } }],
      }),
    );

    expect(progress).toEqual({
      phase: "pulling",
      message,
      detail: null,
    });
  });

  it("reports workspace initialization while the runtime waits for its init container", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
        initContainerStatuses: [
          {
            name: "initialize-workspace",
            state: { running: { startedAt: new Date() } },
          },
        ],
        containerStatuses: [
          { state: { waiting: { reason: "PodInitializing" } } },
        ],
      }),
    );

    expect(progress).toEqual({
      phase: "pulling",
      message: "Preparing the Agent",
      detail: null,
    });
  });

  it.for([
    "Pending",
    "Failed",
  ])("surfaces a failed init container when the pod is %s", (phase) => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase,
        initContainerStatuses: [
          {
            name: "initialize-workspace",
            state: {
              terminated: {
                exitCode: 1,
                reason: "Error",
                message: "Could not initialize workspace volume",
              },
            },
          },
        ],
        containerStatuses: [
          { state: { waiting: { reason: "PodInitializing" } } },
        ],
      }),
    );

    expect(progress.message).toBe("Agent initialization failed");
    expect(progress.detail).toContain("initialize-workspace");
    expect(progress.detail).toContain("exit code 1");
    expect(progress.detail).toContain("Could not initialize workspace volume");
  });

  it("advances past a completed init container to the actual image pull failure", () => {
    const progress = describeAgentRuntimeStartupProgress(
      pod({
        phase: "Pending",
        initContainerStatuses: [
          {
            name: "initialize-workspace",
            state: { terminated: { exitCode: 0, reason: "Completed" } },
          },
        ],
        containerStatuses: [
          {
            state: {
              waiting: { reason: "ErrImagePull", message: "manifest unknown" },
            },
          },
        ],
      }),
    );

    expect(progress.message).toBe("Pulling the agent image");
    expect(progress.detail).toBe("ErrImagePull: manifest unknown");
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
