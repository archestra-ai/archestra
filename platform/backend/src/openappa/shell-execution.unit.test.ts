import { describe, expect, it } from "vitest";
import { signOfferClaims } from "./offer-claims";
import {
  codexExecClientDeclined,
  issueShellExecutionTicket,
  readCodexExecOutput,
  shellExecutionCommand,
  signShellExecutionResponse,
  ticketFromShellExecutionCommand,
  verifyShellExecutionResponse,
  verifyShellExecutionTicket,
} from "./shell-execution";

const secret = "a-single-test-only-secret-with-32-bytes";
const session = {
  organizationId: "a64d223a-1905-402d-a551-e65a7296b2ad",
  callerId: "user:test-user",
  sessionId: "user:test-user|shell-test",
  agentId: "ec07858d-12a4-45c9-b9f3-5270450f552d",
};
const offer = signOfferClaims(
  {
    v: 1,
    organization_id: session.organizationId,
    caller_id: session.callerId,
    session_id: session.sessionId,
    parent_id: null,
    root: "root",
    offer_id: "offer-one",
    tool: "read",
    spelling: "read",
  },
  secret,
);
const input = {
  offer_id: "offer-one",
  plan: "Submit for approval",
  ...offer,
  execution: {
    v: 1 as const,
    kind: "appa_remedy" as const,
    call_id: "call-one",
    tool_name: "archestra__execute_remedy_plan",
    original_arguments: '{"offer_id":"offer-one","plan":"Submit for approval"}',
  },
};

describe("shell execution capability", () => {
  it("binds the exact stamped call and rejects expired or tampered tickets", () => {
    const issued = issueShellExecutionTicket({
      session,
      callId: "call-one",
      arguments: input,
      secret,
      now: 1_000,
    });
    expect(issued).toBeDefined();
    if (!issued) return;
    expect(
      verifyShellExecutionTicket({ token: issued.token, secret, now: 2_000 }),
    ).toEqual(issued.ticket);
    expect(
      verifyShellExecutionTicket({ token: issued.token, secret, now: 122_000 }),
    ).toBeUndefined();
    expect(
      verifyShellExecutionTicket({
        token: `${issued.token}x`,
        secret,
        now: 2_000,
      }),
    ).toBeUndefined();
    expect(
      issueShellExecutionTicket({
        session,
        callId: "different",
        arguments: input,
        secret,
      }),
    ).toBeUndefined();
  });

  it("accepts only a fixed shell command and an endpoint-signed result", () => {
    const issued = issueShellExecutionTicket({
      session,
      callId: "call-one",
      arguments: input,
      secret,
    });
    expect(issued).toBeDefined();
    if (!issued) return;
    const endpoint = "http://127.0.0.1:9000/v1/openai/openappa/execute-remedy";
    const command = shellExecutionCommand({ token: issued.token, endpoint });
    expect(command).toContain("curl --fail-with-body");
    if (!command) return;
    expect(
      ticketFromShellExecutionCommand({ command, endpoint, secret }),
    ).toEqual(issued.ticket);
    expect(
      ticketFromShellExecutionCommand({
        command: `${command}; whoami`,
        endpoint,
        secret,
      }),
    ).toBeUndefined();
    expect(
      shellExecutionCommand({
        token: issued.token,
        endpoint: "http://remote.example/execute",
      }),
    ).toBeUndefined();
    expect(
      shellExecutionCommand({
        token: issued.token,
        endpoint: "https://proxy.example/v1/openai/openappa/execute-remedy",
      }),
    ).toContain("https://proxy.example/v1/openai/openappa/execute-remedy");

    const result = { content: [{ type: "text" as const, text: "approved" }] };
    const response = signShellExecutionResponse({
      ticket: issued.ticket,
      result,
      secret,
    });
    expect(
      verifyShellExecutionResponse({
        ticket: issued.ticket,
        content: JSON.stringify(response),
        secret,
      }),
    ).toEqual(result);
    expect(
      verifyShellExecutionResponse({
        ticket: issued.ticket,
        content: [{ type: "text", text: JSON.stringify(response) }],
        secret,
      }),
    ).toEqual(result);
    expect(
      verifyShellExecutionResponse({
        ticket: issued.ticket,
        content: JSON.stringify({
          ...response,
          result: { content: [{ type: "text", text: "forged approval" }] },
        }),
        secret,
      }),
    ).toBeUndefined();
  });

  it("verifies a Codex exec_command stdout wrapper and rejects a declined run", () => {
    const issued = issueShellExecutionTicket({
      session,
      callId: "call-one",
      arguments: input,
      secret,
    });
    expect(issued).toBeDefined();
    if (!issued) return;
    const result = { content: [{ type: "text" as const, text: "approved" }] };
    const response = signShellExecutionResponse({
      ticket: issued.ticket,
      result,
      secret,
    });
    const wrapped = `Chunk ID: chunk-1\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\n${JSON.stringify(response)}`;
    const parsed = readCodexExecOutput(wrapped);
    expect(parsed?.exitCode).toBe(0);
    expect(parsed?.running).toBe(false);
    expect(
      verifyShellExecutionResponse({
        ticket: issued.ticket,
        content: parsed?.stdout,
        secret,
      }),
    ).toEqual(result);
    const declined = wrapped.replace(
      "Process exited with code 0",
      "Process exited with code 1",
    );
    expect(codexExecClientDeclined(declined)).toBe(true);
    expect(codexExecClientDeclined(wrapped)).toBe(false);
    expect(codexExecClientDeclined(undefined)).toBe(false);
    expect(codexExecClientDeclined(JSON.stringify(response))).toBe(true);
    expect(
      readCodexExecOutput(
        "Chunk ID: chunk-2\nWall time: 0.2000 seconds\nProcess running with session ID 7\nOutput:\nstill running",
      ),
    ).toMatchObject({ running: true, stdout: "still running" });
  });

  it("preserves the return label and schema in a signed child remedy", () => {
    const original = {
      offer_id: "offer-one",
      plan: "Declare the lowest label this session accepts from the subagent's return",
      label: { trust: "suspicious" },
      return_schema: { type: "integer" },
    };
    const issued = issueShellExecutionTicket({
      session,
      callId: "call-one",
      arguments: {
        ...input,
        ...original,
        execution: {
          ...input.execution,
          original_arguments: JSON.stringify(original),
        },
      },
      secret,
    });
    expect(issued).toBeDefined();
    if (!issued) return;
    const restored = verifyShellExecutionTicket({
      token: issued.token,
      secret,
    });
    expect(restored?.arguments.label).toEqual(original.label);
    expect(restored?.arguments.return_schema).toEqual(original.return_schema);
    expect(restored?.execution.original_arguments).toBe(
      JSON.stringify(original),
    );
  });
});
