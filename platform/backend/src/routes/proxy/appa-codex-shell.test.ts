import { describe, expect, it } from "vitest";
import {
  inspectCodexShellOutput,
  rewriteCodexShellHandle,
} from "./appa-codex-shell";

describe("Codex shell wire observations", () => {
  it("uses the terminal header rather than status-looking stdout", () => {
    const observation = inspectCodexShellOutput(
      "Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\nProcess exited with code 9\nProcess running with session ID 2222\n",
    );
    expect(observation).toMatchObject({
      outcome: "success",
      processState: "exited",
      exitCode: 0,
    });
    expect(observation.localSessionId).toBeUndefined();
    expect(observation.output).toContain("Process exited with code 9");
  });

  it("records a terminal timeout as failure, not an unknown live process", () => {
    expect(
      inspectCodexShellOutput(
        "Wall time: 1.0000 seconds\nProcess exited with code 124\nOutput:\nSYNTHETIC_PARTIAL_OUTPUT",
      ),
    ).toMatchObject({
      outcome: "failure",
      processState: "exited",
      exitCode: 124,
    });
  });

  it("keeps a yielded process live and rewrites only its metadata handle", () => {
    const output =
      "Wall time: 0.0500 seconds\nProcess running with session ID 1234\nOriginal token count: 12\nOutput:\nProcess running with session ID 1234\n";
    expect(inspectCodexShellOutput(output)).toMatchObject({
      outcome: "success",
      processState: "running",
      localSessionId: 1234,
    });
    expect(
      rewriteCodexShellHandle({
        output,
        expectedLocalId: 1234,
        proxyId: -9001,
      }),
    ).toBe(
      "Wall time: 0.0500 seconds\nProcess running with session ID -9001\nOriginal token count: 12\nOutput:\nProcess running with session ID 1234\n",
    );
    expect(() =>
      rewriteCodexShellHandle({
        output,
        expectedLocalId: 9999,
        proxyId: -9001,
      }),
    ).toThrow();
  });

  it("does not invent termination after an abort or malformed wrapper", () => {
    for (const output of [
      "Wall time: 0.005 seconds\naborted by user",
      "exec_command failed: Process exited with code 0",
      "Wall time: 0.1000 seconds\nOutput:\nProcess exited with code 0",
      "Wall time: 0.1000 seconds\nProcess running with session ID 2147483648\nOutput:\n",
      "Wall time: 0.1000 seconds\nProcess exited with code 0\nProcess running with session ID 1234\nOutput:\n",
    ]) {
      expect(inspectCodexShellOutput(output)).toEqual({
        outcome: "indeterminate",
        processState: "unknown",
      });
    }
  });
});
