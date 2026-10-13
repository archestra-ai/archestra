import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import {
  mintSubagentBinding,
  subagentChildSession,
  verifySubagentBinding,
} from "./subagent-binding";

const AGENT_ID = randomUUID();
const PARENT = {
  organization_id: "org-1",
  caller_id: "user:user-1",
  session_id: "user:user-1|conversation",
};

function mint() {
  return mintSubagentBinding({
    agentId: AGENT_ID,
    parent: PARENT,
    spawnCallId: "call-1",
  });
}

describe("OpenAPPA subagent binding", () => {
  beforeEach(() => {
    config.openappa.offerSigningSecret = "subagent-binding-test-secret-0123";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens the child under its parent, keyed by the spawn call", () => {
    expect(subagentChildSession(PARENT, "call-1")).toEqual({
      organization_id: "org-1",
      caller_id: "user:user-1",
      session_id: "user:user-1|conversation:agent:call-1",
      parent_id: "user:user-1|conversation",
    });
  });

  test("verifies the binding it minted for the same run", () => {
    const binding = mint();

    expect(
      verifySubagentBinding(binding.token, {
        organizationId: "org-1",
        agentId: AGENT_ID,
      }),
    ).toEqual(binding);
  });

  test("refuses another agent, another organization, or a changed payload", () => {
    const { token } = mint();
    const [payload, signature] = token.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.parentId = "user:user-1|someone-else";
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;

    expect(
      verifySubagentBinding(token, {
        organizationId: "org-1",
        agentId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      verifySubagentBinding(token, {
        organizationId: "org-2",
        agentId: AGENT_ID,
      }),
    ).toBeNull();
    expect(
      verifySubagentBinding(tampered, {
        organizationId: "org-1",
        agentId: AGENT_ID,
      }),
    ).toBeNull();
  });

  test("refuses a binding signed under another secret", () => {
    const { token } = mint();
    config.openappa.offerSigningSecret = "another-secret-for-this-deployment";

    expect(
      verifySubagentBinding(token, {
        organizationId: "org-1",
        agentId: AGENT_ID,
      }),
    ).toBeNull();
  });

  test("refuses an expired binding", () => {
    vi.useFakeTimers();
    const { token } = mint();
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);

    expect(
      verifySubagentBinding(token, {
        organizationId: "org-1",
        agentId: AGENT_ID,
      }),
    ).toBeNull();
  });
});
