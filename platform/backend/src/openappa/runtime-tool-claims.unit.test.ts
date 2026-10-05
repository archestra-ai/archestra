import { describe, expect, it } from "vitest";
import {
  RUNTIME_TOOL_PROOF_ARGUMENT,
  signRuntimeToolProof,
  stripRuntimeToolProofs,
  verifyRuntimeToolProof,
} from "./runtime-tool-claims";

const session = {
  organization_id: "org",
  caller_id: "user:owner",
  session_id: "user:owner|workspace:child",
  parent_id: "user:owner|workspace",
};
const request = {
  session,
  toolCallId: "call-start",
  action: "start_run",
  arguments: {
    agent_id: "worker",
    prompt: "Prepare a report",
    attachments: [{ filename: "input.txt", text: "private input" }],
  },
  spawn: true,
  secret: "test-runtime-tool-signing-key",
};

function verify(
  overrides: Partial<Parameters<typeof verifyRuntimeToolProof>[0]> = {},
) {
  return verifyRuntimeToolProof({
    proof: signRuntimeToolProof(request),
    organizationId: session.organization_id,
    callerId: session.caller_id,
    action: request.action,
    arguments: request.arguments,
    secret: request.secret,
    ...overrides,
  });
}

describe("runtime tool origin proofs", () => {
  it("retains the native child source instead of the gateway's root", () => {
    expect(verify()).toEqual({
      session,
      toolCallId: "call-start",
      spawn: true,
    });
  });

  it("tolerates key ordering but binds all nested attachment bytes", () => {
    expect(
      verify({
        arguments: {
          attachments: [{ text: "private input", filename: "input.txt" }],
          prompt: "Prepare a report",
          agent_id: "worker",
        },
      }),
    ).not.toBeNull();
    expect(
      verify({
        arguments: {
          ...request.arguments,
          attachments: [{ filename: "input.txt", text: "substituted" }],
        },
      }),
    ).toBeNull();
  });

  it.each([
    { organizationId: "another-org" },
    { callerId: "user:another-owner" },
    { callerId: undefined },
    { action: "write_workspace_file" },
    { secret: "another-key" },
    { arguments: { ...request.arguments, agent_id: "another-worker" } },
    { proof: "malformed" },
  ])("refuses a proof replayed with different authority or data: %j", (change) => {
    expect(verify(change)).toBeNull();
  });

  it("cannot authorize modified arguments beyond a log truncation boundary", () => {
    const prefix = "x".repeat(200_000);
    const args = { prompt: `${prefix}A` };
    const proof = signRuntimeToolProof({ ...request, arguments: args });
    expect(verify({ proof, arguments: args })).not.toBeNull();
    expect(verify({ proof, arguments: { prompt: `${prefix}B` } })).toBeNull();
  });

  it("does not sign missing keys or recursively cyclic arguments", () => {
    expect(signRuntimeToolProof({ ...request, secret: "" })).toBeUndefined();
    const args: Record<string, unknown> = {};
    args.self = args;
    expect(
      signRuntimeToolProof({ ...request, arguments: args }),
    ).toBeUndefined();
  });

  it("strips replayed proofs from structured history without looping", () => {
    const args = { prompt: "original", [RUNTIME_TOOL_PROOF_ARGUMENT]: "proof" };
    const body: Record<string, unknown> = { calls: [{ arguments: args }] };
    body.self = body;
    stripRuntimeToolProofs(body);
    expect(args).toEqual({ prompt: "original" });
  });

  it("removes proofs from Responses and run_tool JSON arguments", () => {
    const body = {
      input: [
        {
          arguments: JSON.stringify({
            task_id: "task",
            runtime_proof: "proof",
          }),
        },
        {
          arguments: JSON.stringify({
            tool_name: "archestra__steer_run",
            tool_args: { message: "original", runtime_proof: "proof" },
          }),
        },
        { arguments: "non-JSON custom tool input" },
      ],
    };
    stripRuntimeToolProofs(body);
    expect(JSON.parse(body.input[0].arguments)).toEqual({ task_id: "task" });
    expect(JSON.parse(body.input[1].arguments)).toEqual({
      tool_name: "archestra__steer_run",
      tool_args: { message: "original" },
    });
    expect(body.input[2].arguments).toBe("non-JSON custom tool input");
  });
});
