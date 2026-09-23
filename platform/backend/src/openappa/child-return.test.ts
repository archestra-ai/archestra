import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
  childReturnReceiptsConfigured,
  collectAndStripChildReturns,
  mintChildReturnReceipt,
  verifyChildReturnReceipt,
} from "./child-return";
import { mintChildTrajectoryReceipt } from "./child-trajectory-receipt";
import { stampToolCallId } from "./trajectory-stamp";
import { appendChildTrajectoryReceiptToResponse } from "./wire";

const SECRET = "child-return-test-secret-0123456789abcdef";
const RETURN = {
  organizationId: "org-1",
  callerId: "user-1",
  parentId: "user:user-1|root",
  childId: "user:user-1|root:child",
  childNativeId: "child",
  spawnCallId: "spawn-call",
  value: "SUMMARY(24 characters): safe",
} as const;

describe("OpenAPPA stateless child-return receipts", () => {
  beforeEach(() => {
    config.openappa.offerSigningSecret = SECRET;
  });

  test("preserves prose, schemas, and unrelated tool content byte-exact", () => {
    config.openappa.offerSigningSecret = "";
    const userJson =
      ' \n{ "amount": 9007199254740993, "status": { "child": { "completed": "RAW" } } }\t';
    const toolJson =
      ' { "status": { "child": { "completed": "RAW" } }, "amount": 9007199254740993 } ';
    const prose = [
      "Please explain how a finished subagent ABC-DEFG reports results",
      "Explain the <task_result> tag.",
      "Write a <task-notification> example.",
    ];
    const body = {
      messages: [
        { role: "user", content: userJson },
        ...prose.map((content) => ({ role: "user", content })),
        {
          role: "assistant",
          tool_calls: [nativeToolCall("unrelated", "read_file")],
        },
        { role: "tool", tool_call_id: "unrelated", content: toolJson },
      ],
    };

    const collected = collectAndStripChildReturns(body);

    expect(body.messages[0].content).toBe(userJson);
    expect(body.messages[1]).toMatchObject({ content: prose[0] });
    expect(body.messages[2]).toMatchObject({ content: prose[1] });
    expect(body.messages[3]).toMatchObject({ content: prose[2] });
    expect(body.messages[5]).toMatchObject({ content: toolJson });
    expect(collected.receipts).toEqual([]);
    expect(collected.completions).toEqual([]);
  });

  test("enumerates unsigned leaves only at correlated native result sites", () => {
    const raw = JSON.stringify({
      status: { child: { completed: "RAW", raw_output: "DROP-CHILD" } },
      raw_output: "DROP-ROOT",
    });
    const { body, collected } = collectNativeResult(raw, "wait_agent");

    expect(collected.receipts).toEqual([]);
    expect(collected.completions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: "RAW" }),
    ]);
    expect(nativeResultContent(body)).toBe(
      JSON.stringify({ status: { child: { completed: "RAW" } } }),
    );
  });

  test("leaves foreign namespaced wait payloads byte-exact", () => {
    config.openappa.offerSigningSecret = "";
    const output =
      ' { "status": { "job": { "completed": "FOREIGN" } }, "total": 1 } ';
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "foreign-wait",
          name: "wait_agent",
          namespace: "mcp__foreign",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "foreign-wait",
          output,
        },
      ],
    };
    const before = structuredClone(body);

    const collected = collectAndStripChildReturns(body);

    expect(body).toEqual(before);
    expect(body.input[1].output).toBe(output);
    expect(collected).toEqual({ receipts: [], completions: [] });
  });

  test("keeps flat and native Codex namespaces eligible for completion", () => {
    for (const namespace of [undefined, "functions", "multi_agent_v1"]) {
      const body = {
        input: [
          {
            type: "function_call",
            call_id: `native-${namespace ?? "flat"}`,
            name: "wait_agent",
            ...(namespace ? { namespace } : {}),
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: `native-${namespace ?? "flat"}`,
            output: JSON.stringify({
              status: { child: { completed: "RAW" } },
              total: 1,
            }),
          },
        ],
      };

      const collected = collectAndStripChildReturns(body);

      expect(collected.completions).toEqual([
        expect.objectContaining({ childNativeId: "child", value: "RAW" }),
      ]);
      expect(body.input[1].output).toBe(
        JSON.stringify({ status: { child: { completed: "RAW" } } }),
      );
    }
  });

  test("mints one display marker followed by a self-contained machine proof", () => {
    const marker = requiredMarker(RETURN);

    expect(marker).toMatch(
      /^▄█▄▄▄█▄\n██▄█▄██ {2}finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}\n\[appa\] child return appar-[A-Za-z0-9_-]+\.[0-9a-f]{64}\.$/,
    );
    expect(requiredMarker({ ...RETURN, format: "inline" })).toMatch(
      /^finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}\n\[appa\] child return appar-/,
    );
  });

  test("round-trips direct, JSON, and Claude notification carriers", () => {
    const marker = requiredMarker(RETURN);
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            nativeToolCall("direct", "Task"),
            nativeToolCall("wait", "wait_agent"),
          ],
        },
        { role: "tool", tool_call_id: "direct", content: carrier(marker) },
        {
          role: "tool",
          tool_call_id: "wait",
          content: JSON.stringify({
            status: { child: { completed: carrier(marker) } },
          }),
        },
        {
          role: "user",
          content: `<task-notification>\n<task-id>child</task-id>\n<tool-use-id>spawn-call</tool-use-id>\n<status>completed</status>\n<result>${carrier(marker)}</result>\n</task-notification>`,
        },
      ],
    };

    const collected = collectAndStripChildReturns(body);

    expect(collected.receipts).toHaveLength(3);
    expect(collected.completions).toHaveLength(2);
    expect(collected.completions.map((item) => item.envelopeId)).toEqual([
      "wait",
      "spawn-call",
    ]);
    expect(body.messages[1].content).toBe(RETURN.value);
    const waitContent = body.messages[2]?.content;
    if (typeof waitContent !== "string")
      throw new Error("expected wait output");
    expect(JSON.parse(waitContent)).toEqual({
      status: { child: { completed: RETURN.value } },
    });
    expect(body.messages[3].content).toContain(
      `<result>${RETURN.value}</result>`,
    );
    expect(JSON.stringify(body)).not.toContain("finished subagent");
    expect(JSON.stringify(body)).not.toContain("[appa] child return");

    for (const receipt of collected.receipts) {
      expect(verify(receipt)).toMatchObject({
        parentId: RETURN.parentId,
        childId: RETURN.childId,
        childNativeId: RETURN.childNativeId,
        spawnCallId: RETURN.spawnCallId,
        value: RETURN.value,
      });
    }
  });

  test("correlates Responses function-call outputs by native call site", () => {
    const marker = requiredMarker(RETURN);
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "wait-response",
          name: "functions.wait_agent",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "wait-response",
          output: JSON.stringify({
            status: {
              child: {
                completed: carrier(marker),
                raw_output: "DROP-ME",
              },
            },
            raw_output: "DROP-ROOT",
          }),
        },
      ],
    };

    const collected = collectAndStripChildReturns(body);

    expect(body.input[1].output).toBe(
      JSON.stringify({ status: { child: { completed: RETURN.value } } }),
    );
    expect(collected.receipts).toHaveLength(1);
    expect(verify(collected.receipts[0])).not.toBeNull();
  });

  test("reconstructs XML task notifications from signed admitted output only", () => {
    const marker = requiredMarker(RETURN);
    const body = {
      role: "user",
      content: `<task-notification>\n<task-id>child</task-id>\n<tool-use-id>spawn-call</tool-use-id>\n<status>completed</status>\n<raw-output>UNSIGNED-RAW</raw-output>\n<result>${carrier(marker)}</result>\n<unsigned>DROP-ME</unsigned>\n</task-notification>`,
    };

    const collected = collectAndStripChildReturns(body);

    expect(body.content).toBe(
      `<task-notification>\n<task-id>child</task-id>\n<tool-use-id>spawn-call</tool-use-id>\n<status>completed</status>\n<result>${RETURN.value}</result>\n</task-notification>`,
    );
    expect(body.content).not.toContain("UNSIGNED-RAW");
    expect(body.content).not.toContain("DROP-ME");
    expect(verify(collected.receipts[0])).toMatchObject({
      childNativeId: RETURN.childNativeId,
      spawnCallId: RETURN.spawnCallId,
    });
  });

  test("reconstructs JSON subagent notifications without raw sidecars", () => {
    const marker = requiredMarker(RETURN);
    const notification = {
      agent_id: "child",
      tool_use_id: "spawn-call",
      status: {
        completed: carrier(marker),
        raw_output: "UNSIGNED-IN-STATUS",
      },
      raw_output: "UNSIGNED-ROOT",
      other: { nested: "DROP-ME" },
    };
    const body = {
      role: "user",
      content: `<subagent_notification>\n${JSON.stringify(notification)}\n</subagent_notification>`,
    };

    const collected = collectAndStripChildReturns(body);

    expect(body.content).toBe(
      `<subagent_notification>\n${JSON.stringify({ agent_id: "child", tool_use_id: "spawn-call", status: { completed: RETURN.value } })}\n</subagent_notification>`,
    );
    expect(body.content).not.toContain("UNSIGNED");
    expect(body.content).not.toContain("DROP-ME");
    expect(verify(collected.receipts[0])).toMatchObject({
      childNativeId: RETURN.childNativeId,
      spawnCallId: RETURN.spawnCallId,
    });
  });

  test("canonicalizes subagent notifications with an empty completed value", () => {
    const notification = {
      agent_id: "child",
      tool_use_id: "spawn-call",
      status: { completed: "" },
      raw_output: "UNSIGNED-ROOT",
    };
    const body = {
      role: "user",
      content: `<subagent_notification>\n${JSON.stringify(notification)}\n</subagent_notification>`,
    };

    const collected = collectAndStripChildReturns(body);

    expect(body.content).toBe(
      `<subagent_notification>\n${JSON.stringify({ agent_id: "child", tool_use_id: "spawn-call", status: { completed: "" } })}\n</subagent_notification>`,
    );
    expect(body.content).not.toContain("UNSIGNED-ROOT");
    expect(collected.receipts).toEqual([]);
    expect(collected.completions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: "" }),
    ]);
  });

  test("preserves exact admitted bytes and rejects unsigned suffixes", () => {
    const exact = "  admitted bytes  \n\n";
    const returned = { ...RETURN, value: exact };
    const marker = requiredMarker(returned);
    const exactResult = collectNativeResult(`${exact}\n\n${marker}`, "Task");
    const [exactReceipt] = exactResult.collected.receipts;

    expect(nativeResultContent(exactResult.body)).toBe(exact);
    expect(verify(exactReceipt, returned)).not.toBeNull();

    const suffixResult = collectNativeResult(
      `${exact}\n\n${marker}\nUNSIGNED-SUFFIX`,
      "Task",
    );
    const [suffixReceipt] = suffixResult.collected.receipts;
    expect(nativeResultContent(suffixResult.body)).toBe(
      `${exact}\nUNSIGNED-SUFFIX`,
    );
    expect(verify(suffixReceipt, returned)).toBeNull();
  });

  test("strips a nested trajectory proof from a complete direct return before hash verification", () => {
    const fullCarrier = completeResponseCarrier(RETURN);
    const result = collectNativeResult(fullCarrier, "Task");
    const [receipt] = result.collected.receipts;

    expect(nativeResultContent(result.body)).toBe(RETURN.value);
    expect(nativeResultContent(result.body)).not.toContain("appact2-");
    expect(verify(receipt)).toMatchObject({
      childId: RETURN.childId,
      value: RETURN.value,
    });
  });

  test("uses signed claims rather than the display code and rejects proof mutations", () => {
    const marker = requiredMarker(RETURN);
    const prettyTampered = marker.replace(
      /finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}/,
      "finished subagent ZZZ-ZZZZ",
    );
    const [prettyReceipt] = collectNativeResult(carrier(prettyTampered), "Task")
      .collected.receipts;
    expect(prettyReceipt.displayCode).toBe("ZZZ-ZZZZ");
    expect(verify(prettyReceipt)).toMatchObject({ childId: RETURN.childId });

    const forgedCarrier = carrier(mutateProofMac(marker));
    const [forgedReceipt] = collectNativeResult(forgedCarrier, "Task").collected
      .receipts;
    expect(forgedReceipt.token).toMatch(/^appar-/);
    expect(verify(forgedReceipt)).toBeNull();

    expect(verify({ ...prettyReceipt, value: "forged value" })).toBeNull();
    expect(
      verify({ ...prettyReceipt, childNativeId: "different-child" }),
    ).toBeNull();
  });

  test("rejects foreign scope and role claims", () => {
    const [receipt] = collectNativeResult(
      carrier(requiredMarker(RETURN)),
      "Task",
    ).collected.receipts;

    expect(verify(receipt, RETURN, { organizationId: "other-org" })).toBeNull();
    expect(verify(receipt, RETURN, { callerId: "other-user" })).toBeNull();
    expect(verify(receipt, RETURN, { parentId: "other-parent" })).toBeNull();
  });

  test("authenticates each own assistant echo and arrived grandchild separately", () => {
    const currentSession = RETURN.childId;
    const ownMarker = requiredMarker(RETURN);
    const grandchild = {
      ...RETURN,
      parentId: currentSession,
      childId: `${currentSession}:grandchild`,
      childNativeId: "grandchild",
      spawnCallId: "spawn-grandchild",
      value: "SUMMARY(12 characters): grandchild",
    };
    const body = {
      messages: [
        { role: "assistant", content: carrier(ownMarker) },
        {
          role: "user",
          content: `<task-notification>\n<task-id>grandchild</task-id>\n<tool-use-id>spawn-grandchild</tool-use-id>\n<status>completed</status>\n<result>${carrier(requiredMarker(grandchild), grandchild.value)}</result>\n</task-notification>`,
        },
      ],
    };

    const collected = collectAndStripChildReturns(body);
    const [own, arrived] = collected.receipts;

    expect(
      verifyChildReturnReceipt({
        receipt: own,
        organizationId: RETURN.organizationId,
        callerId: RETURN.callerId,
        parentId: currentSession,
      }),
    ).toMatchObject({ childId: currentSession });
    expect(
      verifyChildReturnReceipt({
        receipt: arrived,
        organizationId: RETURN.organizationId,
        callerId: RETURN.callerId,
        parentId: currentSession,
      }),
    ).toMatchObject({ childId: grandchild.childId });
    expect(
      verifyChildReturnReceipt({
        receipt: { ...own, assistantOrigin: false },
        organizationId: RETURN.organizationId,
        callerId: RETURN.callerId,
        parentId: currentSession,
      }),
    ).toBeNull();
  });

  test("binds explicit spawn hints and normalizes trajectory stamps", () => {
    const marker = requiredMarker(RETURN);
    const notification = (spawnCallId: string) => ({
      content: `<task-notification>\n<task-id>child</task-id>\n<tool-use-id>${spawnCallId}</tool-use-id>\n<status>completed</status>\n<result>${carrier(marker)}</result>\n</task-notification>`,
    });
    const [wrong] = collectAndStripChildReturns(
      notification("another-spawn-call"),
    ).receipts;
    expect(verify(wrong)).toBeNull();

    const stampedSpawnCallId = stampToolCallId({
      callId: RETURN.spawnCallId,
      sessionId: "root",
      organizationId: RETURN.organizationId,
      callerId: RETURN.callerId,
      secret: SECRET,
    });
    const [stamped] = collectAndStripChildReturns(
      notification(stampedSpawnCallId),
    ).receipts;
    expect(verify(stamped)).toMatchObject({ spawnCallId: RETURN.spawnCallId });
  });

  test("keeps native child identity optional when signed spawn correlation is present", () => {
    const returned = { ...RETURN, childNativeId: undefined };
    const marker = requiredMarker(returned);
    const body = {
      content: `<task-notification>\n<task-id>observed-later</task-id>\n<tool-use-id>spawn-call</tool-use-id>\n<status>completed</status>\n<result>${carrier(marker)}</result>\n</task-notification>`,
    };

    const collected = collectAndStripChildReturns(body);
    const verified = verify(collected.receipts[0], returned);

    expect(verified).toMatchObject({
      childId: RETURN.childId,
      childNativeId: "observed-later",
      spawnCallId: RETURN.spawnCallId,
    });
  });

  test("enumerates every Codex completion when only one child is signed", () => {
    const marker = requiredMarker(RETURN);
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [nativeToolCall("wait-call", "wait_agent")],
        },
        {
          role: "tool",
          tool_call_id: "wait-call",
          content: JSON.stringify({
            status: {
              child: { completed: carrier(marker) },
              unsignedChild: { completed: "RAW-UNSIGNED-CHILD-RETURN" },
            },
          }),
        },
      ],
    };

    const collected = collectAndStripChildReturns(body);

    expect(collected.completions).toEqual([
      expect.objectContaining({
        childNativeId: "child",
        envelopeId: "wait-call",
        value: RETURN.value,
        receipt: expect.objectContaining({
          token: collected.receipts[0].token,
        }),
      }),
      {
        assistantOrigin: false,
        childNativeId: "unsignedChild",
        envelopeId: "wait-call",
        value: "RAW-UNSIGNED-CHILD-RETURN",
      },
    ]);
    expect(body.messages[1].content).toContain("RAW-UNSIGNED-CHILD-RETURN");
    expect(body.messages[1].content).not.toContain("raw_output");
  });

  test("rejects malformed proof carriers in genuine completed leaves", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [nativeToolCall("wait", "wait_agent")],
        },
        {
          role: "tool",
          tool_call_id: "wait",
          content: JSON.stringify({
            status: {
              child: {
                completed: `${RETURN.value}\n\nfinished subagent ABC-1234`,
              },
            },
          }),
        },
      ],
    };

    expect(() => collectAndStripChildReturns(body)).toThrow(
      "OpenAPPA received a malformed child-return receipt",
    );
  });

  test("verifies through a fresh module graph without process-local state", async () => {
    const [receipt] = collectNativeResult(
      carrier(requiredMarker(RETURN)),
      "Task",
    ).collected.receipts;

    vi.resetModules();
    const reloadedConfig = (await import("@/config")).default;
    reloadedConfig.openappa.offerSigningSecret = SECRET;
    const reloaded = await import("./child-return");

    expect(
      reloaded.verifyChildReturnReceipt({
        receipt,
        organizationId: RETURN.organizationId,
        callerId: RETURN.callerId,
        parentId: RETURN.parentId,
      }),
    ).toMatchObject({ childId: RETURN.childId });
  });

  test("bounds machine-proof parsing and scans large indentation linearly", () => {
    const marker = requiredMarker(RETURN);
    const result = collectNativeResult(
      `${RETURN.value}\n\n${" ".repeat(512 * 1024)}${marker}`,
      "Task",
    );

    expect(nativeResultContent(result.body)).toBe(RETURN.value);
    expect(result.collected.receipts).toHaveLength(1);

    expect(
      verify({
        ...result.collected.receipts[0],
        token: `appar-${"A".repeat(24 * 1024 + 1)}.${"0".repeat(64)}`,
      }),
    ).toBeNull();
  }, 30_000);

  test("requires a signing key to mint or verify", () => {
    const marker = requiredMarker(RETURN);
    const [receipt] = collectNativeResult(carrier(marker), "Task").collected
      .receipts;
    config.openappa.offerSigningSecret = "";

    expect(childReturnReceiptsConfigured()).toBe(false);
    expect(mintChildReturnReceipt(RETURN)).toBeUndefined();
    expect(verify(receipt)).toBeNull();
  });
});

function requiredMarker(
  returned: Parameters<typeof mintChildReturnReceipt>[0],
): string {
  const marker = mintChildReturnReceipt(returned);
  if (!marker) throw new Error("expected a child-return marker");
  return marker;
}

function carrier(marker: string, value: string = RETURN.value): string {
  return `${value}\n\n${marker}`;
}

function completeResponseCarrier(
  returned: Parameters<typeof mintChildReturnReceipt>[0],
): string {
  const trajectory = mintChildTrajectoryReceipt({
    organizationId: returned.organizationId,
    callerId: returned.callerId,
    parentId: returned.parentId,
    childId: returned.childId,
    childNativeId: returned.childNativeId,
    spawnerNativeId: "root-native",
    spawnCallId: returned.spawnCallId,
  });
  if (!trajectory) throw new Error("expected a child-trajectory marker");
  const response = { content: [{ type: "text", text: returned.value }] };
  if (
    !appendChildTrajectoryReceiptToResponse({
      family: "anthropic:messages",
      response,
      footer: trajectory,
    })
  ) {
    throw new Error("expected a complete child response carrier");
  }
  return `${response.content[0].text}\n\n${requiredMarker(returned)}`;
}

function nativeToolCall(id: string, name: string) {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

function collectNativeResult(content: string, toolName: string) {
  const body = {
    messages: [
      {
        role: "assistant",
        tool_calls: [nativeToolCall("native-result", toolName)],
      },
      { role: "tool", tool_call_id: "native-result", content },
    ],
  };
  return { body, collected: collectAndStripChildReturns(body) };
}

function nativeResultContent(
  body: ReturnType<typeof collectNativeResult>["body"],
): string {
  const content = body.messages[1]?.content;
  if (typeof content !== "string") throw new Error("expected tool content");
  return content;
}

function mutateProofMac(marker: string): string {
  return marker.replace(
    /([0-9a-f])\.$/,
    (_match, last: string) => `${last === "0" ? "1" : "0"}.`,
  );
}

function verify(
  receipt: Parameters<typeof verifyChildReturnReceipt>[0]["receipt"],
  returned: Parameters<typeof mintChildReturnReceipt>[0] = RETURN,
  scope: Partial<
    Omit<Parameters<typeof verifyChildReturnReceipt>[0], "receipt">
  > = {},
) {
  return verifyChildReturnReceipt({
    receipt,
    organizationId: scope.organizationId ?? returned.organizationId,
    callerId: scope.callerId ?? returned.callerId,
    parentId: scope.parentId ?? returned.parentId,
  });
}
