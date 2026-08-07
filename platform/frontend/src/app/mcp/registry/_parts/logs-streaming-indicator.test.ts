import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { hasNoPodToStream } from "./logs-streaming-indicator";

// `state: string` so the "waking" case compiles independently of whether the
// shared McpDeploymentState union has grown the literal yet.
const entry = (
  overrides: Partial<Omit<McpDeploymentStatusEntry, "state">> & {
    state: string;
  },
) =>
  ({
    message: "",
    error: null,
    ...overrides,
  }) as McpDeploymentStatusEntry;

describe("hasNoPodToStream", () => {
  it("suppresses the Streaming chip for a hibernated deployment", () => {
    expect(hasNoPodToStream(entry({ state: "hibernated" }))).toBe(true);
  });

  it("suppresses the Streaming chip while a deployment is waking, even if a pod name is already reported", () => {
    expect(
      hasNoPodToStream(entry({ state: "waking", podName: "mcp-abc-123" })),
    ).toBe(true);
  });

  it("suppresses the Streaming chip when pod telemetry is cleared (no podName)", () => {
    expect(hasNoPodToStream(entry({ state: "pending" }))).toBe(true);
  });

  it("keeps the Streaming chip for a running deployment with a pod", () => {
    expect(
      hasNoPodToStream(entry({ state: "running", podName: "mcp-abc-123" })),
    ).toBe(false);
  });

  it("keeps the Streaming chip while the status entry has not arrived yet (unknown, not no-pod)", () => {
    expect(hasNoPodToStream(undefined)).toBe(false);
    expect(hasNoPodToStream(null)).toBe(false);
  });

  it("leaves a failed deployment that still has a pod unchanged (chip logic untouched)", () => {
    expect(
      hasNoPodToStream(entry({ state: "failed", podName: "mcp-abc-123" })),
    ).toBe(false);
  });
});
