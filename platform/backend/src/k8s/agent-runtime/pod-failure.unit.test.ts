import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";
import {
  classifyAgentRuntimePodFailure,
  describeAgentRuntimePodFailure,
} from "./pod-failure";
import {
  AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE,
  AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE,
} from "./workspace-exit";

describe("a Pod the workspace volume stopped", () => {
  test("a full volume has its own code and the runtime's reason", () => {
    const pod = failedPod({
      exitCode: AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE,
      reason: "Error",
      message:
        "The workspace volume is full (19.5 of 19.5 GiB used), so the run stopped. Ask an administrator for a larger workspace volume, then start a new run.",
    });
    expect(describeAgentRuntimePodFailure(pod, "archestra")).toBe(
      [
        "The Agent Runtime pod failed.",
        "Pod: archestra/agent-run-example",
        "Container agent-runtime: Error (exit code 76)",
        "The workspace volume is full (19.5 of 19.5 GiB used), so the run stopped. Ask an administrator for a larger workspace volume, then start a new run.",
      ].join("\n"),
    );
    expect(classifyAgentRuntimePodFailure(pod)).toBe("pod.workspace_full");
  });

  test.each([
    [
      AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE,
      "The workspace volume is full, so the run stopped. Ask an administrator for a larger workspace volume, then start a new run.",
    ],
    [
      AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE,
      "The workspace volume cannot be written, so the run stopped. It may be full, read-only or failing.",
    ],
  ])("exit code %i without a termination message is still explained", (exitCode, explanation) => {
    const description = describeAgentRuntimePodFailure(
      failedPod({ exitCode, reason: "Error" }),
      "archestra",
    );
    expect(description?.split("\n").at(-1)).toBe(explanation);
  });

  test("a volume that refuses writes is a pod failure, not a full volume", () => {
    expect(
      classifyAgentRuntimePodFailure(
        failedPod({
          exitCode: AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE,
          reason: "Error",
        }),
      ),
    ).toBe("pod.failed");
  });

  test("another exit status gets no workspace explanation", () => {
    const description = describeAgentRuntimePodFailure(
      failedPod({ exitCode: 1, reason: "Error" }),
      "archestra",
    );
    expect(description).toContain(
      "Container agent-runtime: Error (exit code 1)",
    );
    expect(description).not.toContain("workspace volume");
  });
});

describe("a container the kernel killed for memory", () => {
  test("says so first, with the time, the limit, the tier and what to do", () => {
    const pod = failedPod({
      exitCode: 137,
      reason: "OOMKilled",
      finishedAt: new Date("2026-11-01T12:50:30Z"),
    });
    pod.spec = {
      containers: [
        {
          name: "agent-runtime",
          env: [{ name: "ARCHESTRA_AGENT_RUNTIME_TIER", value: "S" }],
          resources: { limits: { memory: "8Gi" } },
        },
      ],
    };
    const description = describeAgentRuntimePodFailure(pod, "archestra");
    expect(description?.split("\n")).toEqual([
      "The run ran out of memory. The kernel killed every process in the agent-runtime container (OOMKilled, exit code 137) at 2026-11-01 12:50:30 UTC. It has a memory limit of 8 GiB at tier S. Start the run again at a larger tier, or have the agent run memory-heavy commands, such as type checks, test suites and builds, one at a time and with fewer workers.",
      "The Agent Runtime pod failed.",
      "Pod: archestra/agent-run-example",
      "Container agent-runtime: OOMKilled (exit code 137, memory limit 8Gi)",
    ]);
    // code-review-action reads the killed run's size from the first match of
    // this pattern (src/sizes.ts) to ask for a larger tier.
    expect(
      description?.match(
        /memory limit(?: of)? (\d+(?:\.\d+)?) ?(GiB|Gi|MiB|Mi)\b/i,
      )?.[1],
    ).toBe("8");
    expect(classifyAgentRuntimePodFailure(pod)).toBe("pod.oom_killed");
  });

  test("still explains a pod without a limit, a tier or an exit time", () => {
    expect(
      describeAgentRuntimePodFailure(
        failedPod({ exitCode: 137, reason: "OOMKilled" }),
        "archestra",
      )?.split("\n")[0],
    ).toBe(
      "The run ran out of memory. The kernel killed every process in the agent-runtime container (OOMKilled, exit code 137). Start the run again at a larger tier, or have the agent run memory-heavy commands, such as type checks, test suites and builds, one at a time and with fewer workers.",
    );
  });

  test("an exit code 137 that Kubernetes does not call a memory kill is not one", () => {
    const pod = failedPod({ exitCode: 137, reason: "Error" });
    expect(
      describeAgentRuntimePodFailure(pod, "archestra")?.split("\n")[0],
    ).toBe("The Agent Runtime pod failed.");
    expect(classifyAgentRuntimePodFailure(pod)).toBe("pod.failed");
  });
});

function failedPod(terminated: {
  exitCode: number;
  reason: string;
  message?: string;
  finishedAt?: Date;
}): V1Pod {
  return {
    metadata: { name: "agent-run-example" },
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          name: "agent-runtime",
          image: "example",
          imageID: "example",
          ready: false,
          restartCount: 0,
          state: { terminated },
        },
      ],
    },
  };
}
