import { describe, expect, test } from "@/test";
import { correlateTrajectoryParent } from "./trajectory-parent";

const parent = "11111111-1111-1111-1111-111111111111";
const child = "22222222-2222-2222-2222-222222222222";
const agentId = "agent-1";

describe("trajectory parent correlation", () => {
  test("recovers the parent from a notice stamped on another session", () => {
    expect(
      correlateTrajectoryParent({
        organizationId: "org-notice",
        callerId: "user:notice",
        agentId,
        sessionId: child,
        body: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call_1",
                  name: "archestra__get_remedy_plans",
                  input: {
                    tool: "Bash",
                    arguments: {},
                    ruling: "blocked",
                    notice: { v: 1, call_id: "call_1", session: parent },
                  },
                },
              ],
            },
          ],
        },
        headers: {},
      }),
    ).toBe(parent);
  });

  test("an out-of-band compact under a new session id inherits the parent compact's trajectory", () => {
    const organizationId = "org-oob";
    const callerId = "user:oob";
    expect(
      correlateTrajectoryParent({
        organizationId,
        callerId,
        agentId,
        sessionId: parent,
        body: {
          messages: [
            {
              role: "user",
              content:
                "This session is being continued from a previous conversation that ran out of context.",
            },
          ],
        },
        headers: {},
      }),
    ).toBeUndefined();
    expect(
      correlateTrajectoryParent({
        organizationId,
        callerId,
        agentId,
        sessionId: child,
        body: {
          messages: [
            {
              role: "user",
              content:
                "This session is being continued from a previous conversation that ran out of context.",
            },
          ],
        },
        headers: {},
      }),
    ).toBe(parent);
  });

  test("a fork under a new session id inherits the parent /fork trajectory", () => {
    const organizationId = "org-fork";
    const callerId = "user:fork";
    correlateTrajectoryParent({
      organizationId,
      callerId,
      agentId,
      sessionId: parent,
      body: {
        messages: [
          { role: "user", content: "<command-name>/fork</command-name>" },
        ],
      },
      headers: {},
    });
    expect(
      correlateTrajectoryParent({
        organizationId,
        callerId,
        agentId,
        sessionId: child,
        body: { messages: [{ role: "user", content: "echo appa-fork-probe" }] },
        headers: {},
      }),
    ).toBe(parent);
  });

  test("Chat compaction on one conversation parents the next conversation", () => {
    const organizationId = "org-chat";
    const callerId = "user:chat";
    correlateTrajectoryParent({
      organizationId,
      callerId,
      agentId,
      sessionId: parent,
      body: { messages: [{ role: "user", content: "summarize" }] },
      headers: {},
      source: "chat:compaction",
    });
    expect(
      correlateTrajectoryParent({
        organizationId,
        callerId,
        agentId,
        sessionId: child,
        body: { messages: [{ role: "user", content: "continue" }] },
        headers: {},
        source: "chat",
      }),
    ).toBe(parent);
  });

  test("OpenCode cleared-history compaction parents a new session", () => {
    const organizationId = "org-opencode";
    const callerId = "user:opencode";
    correlateTrajectoryParent({
      organizationId,
      callerId,
      agentId,
      sessionId: parent,
      body: {
        messages: [
          { role: "tool", content: "[Old tool result content cleared]" },
        ],
      },
      headers: { "user-agent": "opencode/1.18.29" },
    });
    expect(
      correlateTrajectoryParent({
        organizationId,
        callerId,
        agentId,
        sessionId: child,
        body: { messages: [{ role: "user", content: "go on" }] },
        headers: { "user-agent": "opencode/1.18.29" },
      }),
    ).toBe(parent);
  });
});
