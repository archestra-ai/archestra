import { describe, expect, test } from "@/test";
import {
  parseTrajectoryStamp,
  stampedSessions,
  stampToolCallId,
} from "./trajectory-stamp";
import { restoreTrajectoryStamps } from "./wire";

const secret = "test-offer-signing-secret-32chars";
const owner = { organizationId: "org-1", callerId: "user:alice", secret };
const stamp = (sessionId: string, callId: string, signer = owner) =>
  stampToolCallId({ ...signer, sessionId, callId });
const parsed = (id: string) => {
  const value = parseTrajectoryStamp(id);
  if (!value) throw new Error(`not a stamp: ${id}`);
  return value;
};

describe("trajectory stamps", () => {
  test("a stamp carries the provider's call id and its session, in an id every provider accepts", () => {
    const id = stamp("0d3990dc-ace0-4952-8ac5-2d5281e7261b", "toolu_01AbC");

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseTrajectoryStamp(id)).toMatchObject({
      sessionId: "0d3990dc-ace0-4952-8ac5-2d5281e7261b",
      callId: "toolu_01AbC",
    });
    expect(stampedSessions({ ...owner, stamps: [parsed(id)] })).toEqual([
      "0d3990dc-ace0-4952-8ac5-2d5281e7261b",
    ]);
  });

  test("provider ids are not stamps", () => {
    for (const id of ["toolu_01AbC", "call_abc", "fc_123", "appat1", ""]) {
      expect(parseTrajectoryStamp(id)).toBeUndefined();
    }
  });

  test.for([
    ["another caller", { ...owner, callerId: "user:mallory" }],
    ["another organization", { ...owner, organizationId: "org-2" }],
    [
      "another secret",
      { ...owner, secret: "another-signing-secret-32-chars!!" },
    ],
    ["no secret", { ...owner, secret: "" }],
  ] as const)("a stamp names nothing for %s", ([, verifier]) => {
    const genuine = parsed(stamp("session-a", "call_1"));

    expect(stampedSessions({ ...verifier, stamps: [genuine] })).toEqual([]);
  });

  test("a stamp whose session was swapped names nothing", () => {
    const genuine = parsed(stamp("session-a", "call_1"));
    const forged = parsed(
      `appat1${Buffer.from("session-b\u0000call_1").toString("base64url")}${genuine.tag}`,
    );

    expect(forged.sessionId).toBe("session-b");
    expect(stampedSessions({ ...owner, stamps: [forged] })).toEqual([]);
  });

  test("names each session once, the one with the latest calls last", () => {
    const stamps = [
      parsed(stamp("parent", "call_1")),
      parsed(stamp("fork", "call_2")),
      parsed(stamp("parent", "call_3")),
      parsed(stamp("fork", "call_4")),
    ];

    expect(stampedSessions({ ...owner, stamps })).toEqual(["parent", "fork"]);
  });

  test("restores the provider's ids on every wire and reports the stamps", () => {
    const anthropic = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading it" },
            {
              type: "tool_use",
              id: stamp("s", "toolu_1"),
              name: "Read",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: stamp("s", "toolu_1"),
              content: "ok",
            },
          ],
        },
      ],
    };
    const responses = {
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: stamp("s", "call_1"),
          name: "shell",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: stamp("s", "call_1"),
          output: "ok",
        },
      ],
    };
    const chat = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: stamp("s", "call_1"),
              type: "function",
              function: { name: "shell", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: stamp("s", "call_1"), content: "ok" },
      ],
    };

    expect(
      restoreTrajectoryStamps({
        family: "anthropic:messages",
        body: anthropic,
      }),
    ).toHaveLength(2);
    expect(anthropic.messages[0].content[1]).toMatchObject({ id: "toolu_1" });
    expect(anthropic.messages[1].content[0]).toMatchObject({
      tool_use_id: "toolu_1",
    });

    expect(
      restoreTrajectoryStamps({ family: "openai:responses", body: responses }),
    ).toHaveLength(2);
    expect(responses.input.map((item) => item.call_id)).toEqual([
      "call_1",
      "call_1",
    ]);

    expect(
      restoreTrajectoryStamps({ family: "openai:chatCompletions", body: chat }),
    ).toHaveLength(2);
    expect(chat.messages[0].tool_calls?.[0].id).toBe("call_1");
    expect(chat.messages[1].tool_call_id).toBe("call_1");
  });
});
