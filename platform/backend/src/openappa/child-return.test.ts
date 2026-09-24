import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
  childReturnMarkersConfigured,
  collectAndStripChildReturns,
  mintChildReturnMarker,
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

describe("OpenAPPA child-return markers", () => {
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
    expect(collected.completions).toEqual([]);
  });

  test("extracts OpenCode task returns with summaries and drops unsigned summary text", () => {
    const rawSummary = "UNTRUSTED CHILD SUMMARY";
    const output = `<task id="child" state="completed">\n<summary>${rawSummary}</summary>\n<task_result>\n${carrier(requiredMarker(RETURN))}\n</task_result>\n</task>`;
    const { body, collected } = collectNativeResult(output, "task");

    expect(collected.completions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: RETURN.value }),
    ]);
    expect(nativeResultContent(body)).toBe(
      `<task_result>${RETURN.value}</task_result>`,
    );
    expect(nativeResultContent(body)).not.toContain(rawSummary);
  });

  test("treats a synthetic OpenCode user message as a child return", () => {
    const output = `<task id="child" state="completed">\n<summary>UNTRUSTED</summary>\n<task_result>\n${carrier(requiredMarker(RETURN))}\n</task_result>\n</task>`;
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: output }] }],
    };

    const collected = collectAndStripChildReturns(body, {
      openCodeBackgroundReturns: true,
    });

    expect(collected.completions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: RETURN.value }),
    ]);
    expect(body.messages[0].content[0].text).toBe(
      `<task_result>${RETURN.value}</task_result>`,
    );

    const unsigned = {
      messages: [
        {
          role: "user",
          content: output.replace(carrier(requiredMarker(RETURN)), "RAW"),
        },
      ],
    };
    const unsignedCompletions = collectAndStripChildReturns(unsigned, {
      openCodeBackgroundReturns: true,
    }).completions;
    expect(unsignedCompletions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: "RAW" }),
    ]);

    expect(() =>
      collectAndStripChildReturns(
        {
          messages: [
            {
              role: "user",
              content: '<task id="child" state="completed">RAW</task>',
            },
          ],
        },
        { openCodeBackgroundReturns: true },
      ),
    ).toThrow("OpenAPPA withheld a malformed child completion");
  });

  test("preserves other clients' user text and unrelated OpenCode message parts", () => {
    const output = `<task id="child" state="completed">\n<summary>Text</summary>\n<task_result>\n${carrier(requiredMarker(RETURN))}\n</task_result>\n</task>`;
    const otherClient = { messages: [{ role: "user", content: output }] };
    expect(collectAndStripChildReturns(otherClient).completions).toEqual([]);
    expect(otherClient.messages[0].content).toBe(output);

    const unrelated = carrier(requiredMarker(RETURN));
    const openCode = {
      messages: [
        {
          role: "user",
          status: { completed: "keep user metadata" },
          content: [
            { type: "text", text: unrelated },
            {
              type: "text",
              text: output,
              status: { completed: "keep part metadata" },
            },
          ],
        },
      ],
    };
    const { completions } = collectAndStripChildReturns(openCode, {
      openCodeBackgroundReturns: true,
    });
    expect(completions).toHaveLength(1);
    expect(openCode.messages[0]).toMatchObject({
      role: "user",
      status: { completed: "keep user metadata" },
    });
    expect(openCode.messages[0].content[0].text).toBe(unrelated);
    expect(openCode.messages[0].content[1]).toMatchObject({
      status: { completed: "keep part metadata" },
      text: `<task_result>${RETURN.value}</task_result>`,
    });
  });

  test("keeps a leading newline inside an unwrapped task_result", () => {
    const multiline = { ...RETURN, value: "\nLEADING" };
    const { body, collected } = collectNativeResult(
      `<task_result>${carrier(requiredMarker(multiline), multiline.value)}</task_result>`,
      "task",
    );
    expect(collected.completions).toEqual([
      expect.objectContaining({ value: multiline.value }),
    ]);
    expect(nativeResultContent(body)).toBe(
      `<task_result>${multiline.value}</task_result>`,
    );
  });

  test("enumerates unsigned leaves only at correlated native result sites", () => {
    const raw = JSON.stringify({
      status: { child: { completed: "RAW", raw_output: "DROP-CHILD" } },
      raw_output: "DROP-ROOT",
    });
    const { body, collected } = collectNativeResult(raw, "wait_agent");

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
    expect(collected).toEqual({ completions: [] });
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

  test("mints a display-only marker without any machine line", () => {
    const marker = requiredMarker(RETURN);

    expect(marker).toMatch(
      /^▄█▄▄▄█▄\n██▄█▄██ {2}finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(requiredMarker({ ...RETURN, format: "inline" })).toMatch(
      /^finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(marker).not.toContain("[appa]");
  });

  test("strips direct, JSON, and Claude notification carriers", () => {
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

    expect(collected.completions).toHaveLength(3);
    expect(collected.completions.map((item) => item.envelopeId)).toEqual([
      "direct",
      "wait",
      "spawn-call",
    ]);
    expect(
      collected.completions.every((item) => item.value === RETURN.value),
    ).toBe(true);
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
    expect(collected.completions).toEqual([
      expect.objectContaining({
        childNativeId: "child",
        envelopeId: "wait-response",
        value: RETURN.value,
      }),
    ]);
  });

  test("reconstructs XML task notifications from the completion value only", () => {
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
    expect(collected.completions).toEqual([
      expect.objectContaining({
        childNativeId: RETURN.childNativeId,
        spawnCallId: RETURN.spawnCallId,
        value: RETURN.value,
      }),
    ]);
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
    expect(collected.completions).toEqual([
      expect.objectContaining({
        childNativeId: RETURN.childNativeId,
        spawnCallId: RETURN.spawnCallId,
        value: RETURN.value,
      }),
    ]);
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
    expect(collected.completions).toEqual([
      expect.objectContaining({ childNativeId: "child", value: "" }),
    ]);
  });

  test("preserves exact bytes around the marker, suffix included", () => {
    const exact = "  admitted bytes  \n\n";
    const returned = { ...RETURN, value: exact };
    const marker = requiredMarker(returned);
    const exactResult = collectNativeResult(`${exact}\n\n${marker}`, "Task");

    expect(nativeResultContent(exactResult.body)).toBe(exact);
    expect(exactResult.collected.completions).toEqual([
      expect.objectContaining({ value: exact }),
    ]);

    // A suffix beside the marker stays part of the completion value, so the
    // durable crossing check downstream rejects what the child never returned.
    const suffixResult = collectNativeResult(
      `${exact}\n\n${marker}\nUNSIGNED-SUFFIX`,
      "Task",
    );
    expect(nativeResultContent(suffixResult.body)).toBe(
      `${exact}\nUNSIGNED-SUFFIX`,
    );
    expect(suffixResult.collected.completions).toEqual([
      expect.objectContaining({ value: `${exact}\nUNSIGNED-SUFFIX` }),
    ]);
  });

  test("strips a nested trajectory proof from a complete direct return", () => {
    const fullCarrier = completeResponseCarrier(RETURN);
    const result = collectNativeResult(fullCarrier, "Task");

    expect(nativeResultContent(result.body)).toBe(RETURN.value);
    expect(nativeResultContent(result.body)).not.toContain("appact2-");
    expect(result.collected.completions).toEqual([
      expect.objectContaining({ value: RETURN.value }),
    ]);
  });

  test("treats the display code as display-only", () => {
    const marker = requiredMarker(RETURN);
    const prettyTampered = marker.replace(
      /finished subagent [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}/,
      "finished subagent ZZZ-ZZZZ",
    );
    const result = collectNativeResult(carrier(prettyTampered), "Task");

    // Any well-formed code strips; authority is the retained crossing, so a
    // painted code cannot weaken or strengthen a completion.
    expect(result.collected.completions).toEqual([
      expect.objectContaining({ value: RETURN.value }),
    ]);
    expect(nativeResultContent(result.body)).toBe(RETURN.value);
  });

  test("records an assistant echo separately from an arrived grandchild", () => {
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

    expect(collected.completions).toEqual([
      expect.objectContaining({
        assistantOrigin: true,
        value: RETURN.value,
      }),
      expect.objectContaining({
        assistantOrigin: false,
        childNativeId: "grandchild",
        spawnCallId: "spawn-grandchild",
        value: grandchild.value,
      }),
    ]);
    expect(body.messages[0].content).toBe(RETURN.value);
    expect(body.messages[1].content).toContain(
      `<result>${grandchild.value}</result>`,
    );
  });

  test("records spawn hints from notification metadata verbatim", () => {
    const marker = requiredMarker(RETURN);
    const notification = (spawnCallId: string) => ({
      content: `<task-notification>\n<task-id>child</task-id>\n<tool-use-id>${spawnCallId}</tool-use-id>\n<status>completed</status>\n<result>${carrier(marker)}</result>\n</task-notification>`,
    });
    const [other] = collectAndStripChildReturns(
      notification("another-spawn-call"),
    ).completions;
    expect(other).toMatchObject({ spawnCallId: "another-spawn-call" });

    const stampedSpawnCallId = stampToolCallId({
      callId: RETURN.spawnCallId,
      sessionId: "root",
      organizationId: RETURN.organizationId,
      callerId: RETURN.callerId,
      secret: SECRET,
    });
    const [stamped] = collectAndStripChildReturns(
      notification(stampedSpawnCallId),
    ).completions;
    expect(stamped).toMatchObject({ spawnCallId: stampedSpawnCallId });
  });

  test("records the notification's native child identity", () => {
    const returned = { ...RETURN, childNativeId: undefined };
    const marker = requiredMarker(returned);
    const body = {
      content: `<task-notification>\n<task-id>observed-later</task-id>\n<tool-use-id>spawn-call</tool-use-id>\n<status>completed</status>\n<result>${carrier(marker)}</result>\n</task-notification>`,
    };

    const collected = collectAndStripChildReturns(body);

    expect(collected.completions).toEqual([
      expect.objectContaining({
        childNativeId: "observed-later",
        spawnCallId: RETURN.spawnCallId,
        value: RETURN.value,
      }),
    ]);
  });

  test("enumerates every Codex completion whether or not a marker is present", () => {
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

  test("rejects malformed marker carriers in genuine completed leaves", () => {
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
                completed: `${RETURN.value}\n\nfinished subagent`,
              },
            },
          }),
        },
      ],
    };

    expect(() => collectAndStripChildReturns(body)).toThrow(
      "OpenAPPA received a malformed child-return marker",
    );
  });

  test("mints deterministically through a fresh module graph", async () => {
    const marker = requiredMarker(RETURN);

    vi.resetModules();
    const reloadedConfig = (await import("@/config")).default;
    reloadedConfig.openappa.offerSigningSecret = SECRET;
    const reloaded = await import("./child-return");

    expect(reloaded.mintChildReturnMarker(RETURN)).toBe(marker);
  });

  test("bounds marker scanning and scans large indentation linearly", () => {
    const marker = requiredMarker(RETURN);
    const result = collectNativeResult(
      `${RETURN.value}\n\n${" ".repeat(512 * 1024)}${marker}`,
      "Task",
    );

    expect(nativeResultContent(result.body)).toBe(RETURN.value);
    expect(result.collected.completions).toEqual([
      expect.objectContaining({ value: RETURN.value }),
    ]);
  }, 30_000);

  test("requires a signing key to mint", () => {
    config.openappa.offerSigningSecret = "";

    expect(childReturnMarkersConfigured()).toBe(false);
    expect(mintChildReturnMarker(RETURN)).toBeUndefined();
  });
});

function requiredMarker(
  returned: Parameters<typeof mintChildReturnMarker>[0],
): string {
  const marker = mintChildReturnMarker(returned);
  if (!marker) throw new Error("expected a child-return marker");
  return marker;
}

function carrier(marker: string, value: string = RETURN.value): string {
  return `${value}\n\n${marker}`;
}

function completeResponseCarrier(
  returned: Parameters<typeof mintChildReturnMarker>[0],
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
