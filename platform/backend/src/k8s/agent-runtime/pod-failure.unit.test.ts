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
        "The workspace volume is full (19.5 of 19.5 GiB used), so the run stopped. Start a new run with a larger workspace volume.",
    });
    expect(describeAgentRuntimePodFailure(pod, "archestra")).toBe(
      [
        "The Agent Runtime pod failed.",
        "Pod: archestra/agent-run-example",
        "Container agent-runtime: Error (exit code 76)",
        "The workspace volume is full (19.5 of 19.5 GiB used), so the run stopped. Start a new run with a larger workspace volume.",
      ].join("\n"),
    );
    expect(classifyAgentRuntimePodFailure(pod)).toBe("pod.workspace_full");
  });

  test.each([
    [
      AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE,
      "The workspace volume is full, so the run stopped. Start a new run with a larger workspace volume.",
    ],
    [
      AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE,
      "The workspace volume cannot be written, so the run stopped. It may be read-only or failing. Ask the cluster operator to check it.",
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

function failedPod(terminated: {
  exitCode: number;
  reason: string;
  message?: string;
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
