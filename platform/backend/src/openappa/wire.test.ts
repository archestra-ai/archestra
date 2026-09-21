import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { openappaActor } from "./actor";
import {
  buildNoticeArguments,
  NoticeArguments,
  RemedyExecutionSchema,
  readNotice,
} from "./notice";
import { namespacedToolName, prepareAppaRequest } from "./request";
import { appendSessionReceipt } from "./session-token";
import {
  appaSessionIdentity,
  appaTurnBoundaries,
  appaWireFamily,
  appendSessionReceiptToResponse,
  canonicalJson,
  declaredToolName,
  sessionReceiptEvidence,
  stripSessionReceiptsFromRequest,
} from "./wire";

const NOTICE = "mcp__archestra__get_remedy_plans";
const CONTROL = "mcp__archestra__execute_remedy_plan";
const canonicalize = (name: string) =>
  name.startsWith("mcp__archestra__")
    ? `archestra__${name.slice("mcp__archestra__".length)}`
    : name;

describe("session receipt text carriers", () => {
  const organizationId = "org-envelope";
  const callerId = "user:alice";
  const code = "AAA-AAAA";
  const receipt = (text: string) => appendSessionReceipt(text, code);

  test.each([
    {
      family: "anthropic:messages" as const,
      response: { content: [{ type: "text", text: "" }] },
    },
    {
      family: "openai:chatCompletions" as const,
      response: { choices: [{ message: { content: "" } }] },
    },
    {
      family: "openai:responses" as const,
      response: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        ],
      },
    },
  ])("does not turn empty $family output into provenance", ({
    family,
    response,
  }) => {
    const original = structuredClone(response);
    expect(appendSessionReceiptToResponse({ family, response, code })).toBe(
      false,
    );
    expect(response).toEqual(original);
  });

  test.each([
    {
      family: "anthropic:messages" as const,
      body: () => ({
        messages: [
          { role: "user", content: `prefix ${receipt("summary")} suffix` },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                content: "<!-- appa-context-v1:broken -->",
              },
            ],
          },
        ],
      }),
      text: (body: Record<string, unknown>) =>
        (body.messages as Array<{ content: string }>)[0].content,
    },
    {
      family: "openai:chatCompletions" as const,
      body: () => ({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: receipt("summary") }],
          },
          { role: "tool", content: "<!-- appa-context-v1:broken -->" },
        ],
      }),
      text: (body: Record<string, unknown>) =>
        (body.messages as Array<{ content: Array<{ text: string }> }>)[0]
          .content[0].text,
    },
    {
      family: "openai:responses" as const,
      body: () => ({
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: receipt("summary") }],
          },
          {
            type: "function_call_output",
            call_id: "call",
            output: "<!-- appa-context-v1:broken -->",
          },
        ],
        instructions: "<!-- appa-context-v1:broken -->",
      }),
      text: (body: Record<string, unknown>) =>
        (body.input as Array<{ content: Array<{ text: string }> }>)[0]
          .content[0].text,
    },
  ])("restores only explicit %s conversational text", async ({
    family,
    body,
    text,
  }) => {
    await db.insert(schema.openappaSessionsTable).values({
      actor: openappaActor("user:alice|parent"),
      root: openappaActor("user:alice|parent"),
      organizationId,
      callerId,
      sessionId: "user:alice|parent",
      receiptToken: code,
      startDecision: { decision: "ack" },
    });
    const request = body();
    const codes = stripSessionReceiptsFromRequest({ family, body: request });
    expect(
      await sessionReceiptEvidence({ organizationId, callerId, codes }),
    ).toEqual(["parent"]);
    expect(text(request)).toContain("summary");
    expect(text(request)).not.toContain("protected session");
  });

  test.each([
    {
      family: "anthropic:messages" as const,
      response: { content: [{ type: "text", text: "answer" }] },
      text: (response: { content: Array<{ text: string }> }) =>
        response.content[0].text,
    },
    {
      family: "openai:chatCompletions" as const,
      response: { choices: [{ message: { content: "answer" } }] },
      text: (response: { choices: Array<{ message: { content: string } }> }) =>
        response.choices[0].message.content,
    },
    {
      family: "openai:responses" as const,
      response: {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      },
      text: (response: {
        output: Array<{ content: Array<{ text: string }> }>;
      }) => response.output[0].content[0].text,
    },
  ])("appends a restorable footer to %s output text", async ({
    family,
    response,
    text,
  }) => {
    await db.insert(schema.openappaSessionsTable).values({
      actor: openappaActor("user:alice|parent"),
      root: openappaActor("user:alice|parent"),
      organizationId,
      callerId,
      sessionId: "user:alice|parent",
      receiptToken: code,
      startDecision: { decision: "ack" },
    });
    appendSessionReceiptToResponse({ family, response, code });
    const request =
      family === "openai:responses"
        ? {
            input: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: text(response) }],
              },
            ],
          }
        : {
            messages: [
              family === "anthropic:messages"
                ? {
                    role: "assistant",
                    content: [{ type: "text", text: text(response) }],
                  }
                : { role: "assistant", content: text(response) },
            ],
          };
    const codes = stripSessionReceiptsFromRequest({ family, body: request });
    expect(
      await sessionReceiptEvidence({ organizationId, callerId, codes }),
    ).toEqual(["parent"]);
  });
});

describe("denial notice restoration", () => {
  test("keeps the public notice schema strict for function and custom calls", () => {
    const base = {
      tool: "shell",
      ruling: "[appa] Blocked: this call cannot run yet.",
      notice: { v: 1 as const, call_id: "call_schema" },
    };

    expect(NoticeArguments.safeParse({ ...base, arguments: 42 }).success).toBe(
      false,
    );
    expect(
      NoticeArguments.safeParse({
        ...base,
        arguments: { command: "ls" },
        notice: { ...base.notice, custom: true },
      }).success,
    ).toBe(false);
    expect(
      NoticeArguments.safeParse({
        ...base,
        arguments: { input: "ls" },
        notice: { ...base.notice, custom: true },
      }).success,
    ).toBe(true);
    expect(
      NoticeArguments.safeParse({
        ...base,
        arguments: { input: "ls", arbitrary: true },
        notice: { ...base.notice, custom: true },
      }).success,
    ).toBe(false);
    expect(
      NoticeArguments.safeParse({
        ...base,
        arguments: JSON.stringify({ input: "ls", arbitrary: true }),
        notice: { ...base.notice, custom: true },
      }).success,
    ).toBe(false);
  });

  test("validates the shared bounded execution receipt contract", () => {
    const execution = {
      v: 1 as const,
      kind: "appa_remedy" as const,
      call_id: "call_1",
      tool_name: CONTROL,
      original_arguments: '{ "offer_id": "offer_1" }',
    };

    expect(RemedyExecutionSchema.safeParse(execution).success).toBe(true);
    expect(
      RemedyExecutionSchema.safeParse({
        v: execution.v,
        kind: execution.kind,
        call_id: execution.call_id,
        original_arguments: execution.original_arguments,
      }).success,
    ).toBe(false);
    expect(
      RemedyExecutionSchema.safeParse({
        ...execution,
        call_id: "x".repeat(513),
      }).success,
    ).toBe(false);
    expect(
      RemedyExecutionSchema.safeParse({
        ...execution,
        original_arguments: "not JSON",
      }).success,
    ).toBe(false);
  });

  test("restores an Anthropic denial to the original call, leaving signed thinking untouched", () => {
    const thinking = {
      type: "thinking",
      thinking: "the user asked for a cleanup",
      signature: "sig-abc",
    };
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }, { name: "Bash" }],
      messages: [
        { role: "user", content: "clean the build" },
        {
          role: "assistant",
          content: [
            thinking,
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "whatever the client recorded",
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    const assistant = body.messages[1].content as Record<string, unknown>[];
    expect(assistant[0]).toBe(thinking);
    expect(assistant[1]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "rm -rf build" },
    });
    const result = (body.messages[2].content as Record<string, unknown>[])[0];
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "[appa] Blocked: this call cannot run yet.",
      is_error: true,
    });
  });

  test("restores the same bytes on every request, so the turn stays cacheable", () => {
    const build = () => ({
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "held" },
          ],
        },
      ],
    });
    const first = build();
    const second = build();

    for (const body of [first, second]) {
      prepareAppaRequest({
        body,
        interactionType: "anthropic:messages",
        canonicalizeToolName: canonicalize,
      });
    }

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("restores a Responses function call and its output without touching reasoning items", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque",
    };
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        reasoning,
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          status: "completed",
          arguments: JSON.stringify(
            notice("shell", { command: "rm -rf /" }, "call_1"),
          ),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "client text",
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0]).toBe(reasoning);
    expect(body.input[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "shell",
      status: "completed",
      arguments: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "[appa] Blocked: this call cannot run yet.",
    });
  });

  test("preserves validated function argument bytes on Responses and Chat restoration", () => {
    const rawArguments =
      '{\n  "command": "printf \\u0041",\n  "padding": [1, 2]\n}';
    const noticeArguments = buildNoticeArguments({
      id: "call_raw",
      tool: "shell",
      arguments: rawArguments,
      result: "[appa] Blocked: this call cannot run yet.",
    });

    expect(noticeArguments.arguments).toBe(rawArguments);
    expect(
      readNotice({
        callId: "call_raw",
        arguments: JSON.stringify(noticeArguments),
      })?.original,
    ).toEqual({
      kind: "function",
      arguments: { command: "printf A", padding: [1, 2] },
      rawArguments,
    });

    const responses = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          call_id: "call_raw",
          name: NOTICE,
          arguments: JSON.stringify(noticeArguments),
        },
      ],
    };
    const chat = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
      ],
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_raw",
              function: {
                name: NOTICE,
                arguments: JSON.stringify(noticeArguments),
              },
            },
          ],
        },
      ],
    };
    const anthropic = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_raw",
              name: NOTICE,
              input: noticeArguments,
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body: responses,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });
    prepareAppaRequest({
      body: chat,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });
    prepareAppaRequest({
      body: anthropic,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(responses.input[0].arguments).toBe(rawArguments);
    expect(chat.messages[0].tool_calls[0].function.arguments).toBe(
      rawArguments,
    );
    expect(anthropic.messages[0].content[0].input).toEqual({
      command: "printf A",
      padding: [1, 2],
    });
  });

  test("leaves a notice for a name no provider accepts as the notice", () => {
    // A model invented "my_gateway archestra__run_tool"; restored into
    // history, the name fails the provider's validation on every later turn.
    const invented = buildNoticeArguments({
      id: "call_invented",
      tool: "my_gateway archestra__run_tool",
      arguments: '{"tool_name":"archestra__whoami"}',
      result: "[appa] tool is not declared",
    });
    const denied = buildNoticeArguments({
      id: "call_shell",
      tool: "shell",
      arguments: '{"command":"ls"}',
      result: "[appa] Blocked",
    });
    const call = (id: string, args: unknown) => ({
      id,
      type: "function",
      function: { name: NOTICE, arguments: JSON.stringify(args) },
    });
    const chat = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
      ],
      messages: [
        {
          role: "assistant",
          tool_calls: [
            call("call_invented", invented),
            call("call_shell", denied),
          ],
        },
        { role: "tool", tool_call_id: "call_invented", content: "ruling" },
        { role: "tool", tool_call_id: "call_shell", content: "ruling" },
      ],
    };

    prepareAppaRequest({
      body: chat,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });

    const [kept, restored] = chat.messages[0].tool_calls ?? [];
    expect(kept.function.name).toBe(NOTICE);
    expect(restored.function.name).toBe("shell");
  });

  test("restores a direct control receipt without changing call identity or result adjacency", () => {
    const originalArguments =
      '{\n  "offer_id": "offer_1",\n  "label": { "trust": "trusted" }\n}';
    const receipt = (callId: string) => ({
      offer_id: "offer_1",
      label: { trust: "trusted" },
      execution: {
        v: 1 as const,
        kind: "appa_remedy" as const,
        call_id: callId,
        tool_name: CONTROL,
        original_arguments: originalArguments,
      },
    });
    const responses = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          id: "fc_control",
          call_id: "call_control",
          name: CONTROL,
          namespace: "gateway",
          arguments: JSON.stringify(receipt("call_control")),
        },
        {
          type: "function_call_output",
          call_id: "call_control",
          output: "gateway result",
        },
      ],
    };
    const chat = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
      ],
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_control",
              type: "function",
              function: {
                name: CONTROL,
                arguments: JSON.stringify(receipt("call_control")),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_control",
          content: "gateway result",
        },
      ],
    };
    const anthropic = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_control",
              name: CONTROL,
              input: receipt("call_control"),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_control",
              content: "gateway result",
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body: responses,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });
    prepareAppaRequest({
      body: chat,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });
    prepareAppaRequest({
      body: anthropic,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(responses.input[0]).toMatchObject({
      id: "fc_control",
      call_id: "call_control",
      name: CONTROL,
      namespace: "gateway",
      arguments: originalArguments,
    });
    expect(responses.input[1]).toEqual({
      type: "function_call_output",
      call_id: "call_control",
      output: "gateway result",
    });
    expect(chat.messages[0]?.tool_calls?.[0]?.function.arguments).toBe(
      originalArguments,
    );
    expect(chat.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_control",
      content: "gateway result",
    });
    expect(anthropic.messages[0]).toMatchObject({
      content: [
        {
          type: "tool_use",
          input: { offer_id: "offer_1", label: { trust: "trusted" } },
        },
      ],
    });
    expect(anthropic.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_control",
      content: "gateway result",
    });
  });

  test.each([
    "valid",
    "foreign-kind",
    "changed-arguments",
  ] as const)("restores typed execution history without current tool declarations (%s)", (variant) => {
    const name = "custom.gateway.remedy";
    const original =
      '{ "offer_id": "offer_1", "label": { "trust": "trusted" } }';
    const argumentsText = JSON.stringify({
      offer_id: "offer_1",
      label: {
        trust: variant === "changed-arguments" ? "untrusted" : "trusted",
      },
      execution: {
        v: 1,
        kind: variant === "foreign-kind" ? "business-record" : "appa_remedy",
        call_id: "call_control",
        tool_name: name,
        original_arguments: original,
      },
    });
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_control",
          name,
          arguments: argumentsText,
        },
      ],
    };
    const prepared = prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: (tool) => tool,
    });
    expect(prepared.tools).toBeUndefined();
    expect(body.input[0].arguments).toBe(
      variant === "valid" ? original : argumentsText,
    );
    expect(prepared.historicalControlToolName).toBe(
      variant === "valid" ? name : undefined,
    );
  });

  test.each([
    NOTICE,
    CONTROL,
  ])("requires a structured function declaration for %s", (name) => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: name === NOTICE ? "custom" : "function", name: NOTICE },
            { type: name === CONTROL ? "custom" : "function", name: CONTROL },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("control tools require structured function arguments");
  });

  test("leaves forged, foreign, and custom execution receipts untouched", () => {
    const originalArguments = '{ "offer_id": "offer_1" }';
    const receipt = (callId: string, toolName = CONTROL) =>
      JSON.stringify({
        offer_id: "offer_1",
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: callId,
          tool_name: toolName,
          original_arguments: originalArguments,
        },
      });
    const foreign = "mcp__foreign__archestra__execute_remedy_plan";
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          call_id: "call_forged",
          name: CONTROL,
          arguments: receipt("another_call"),
        },
        {
          type: "function_call",
          call_id: "call_foreign",
          name: foreign,
          arguments: receipt("call_foreign", foreign),
        },
        {
          type: "function_call",
          call_id: "call_wrong_name",
          name: CONTROL,
          arguments: receipt(
            "call_wrong_name",
            "mcp__other__execute_remedy_plan",
          ),
        },
        {
          type: "custom_tool_call",
          call_id: "call_custom",
          name: CONTROL,
          input: receipt("call_custom"),
        },
      ],
    };
    const before = body.input.map((item) => ({ ...item }));

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input).toEqual(before);
  });

  test("restores notices on an explicitly mapped compatible Responses provider", () => {
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          call_id: "call_compatible",
          name: NOTICE,
          arguments: JSON.stringify(
            notice("read_file", { path: "/tmp/check" }, "call_compatible"),
          ),
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "github-copilot:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_compatible",
      name: "read_file",
      arguments: JSON.stringify({ path: "/tmp/check" }),
    });
  });

  test("restores a denied custom tool call as a custom tool call again", () => {
    // Codex calls `apply_patch` with free-form text. The notice that replaced it
    // is a function call, because the notice tool is a function tool; restoring
    // it has to call the original a custom tool call again.
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
        { type: "custom", name: "apply_patch" },
      ],
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          arguments: JSON.stringify(
            notice(
              "apply_patch",
              { input: "*** Begin Patch\n" },
              "call_1",
              true,
            ),
          ),
        },
        { type: "function_call_output", call_id: "call_1", output: "shown" },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    // The item id follows the kind: the provider wants `ctc_` on a custom
    // tool call, and the client wrote `fc_` for the notice it was handed.
    expect(body.input[0]).toEqual({
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_1",
      name: "apply_patch",
      input: "*** Begin Patch\n",
    });
  });

  test("restores a Chat Completions tool call in place", () => {
    const body = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
      ],
      messages: [
        {
          role: "assistant",
          reasoning_content: "kept",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: NOTICE,
                arguments: JSON.stringify(
                  notice("bash", { command: "ls" }, "call_1"),
                ),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "client text" },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });

    expect(body.messages[0]).toEqual({
      role: "assistant",
      reasoning_content: "kept",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "ls" }),
          },
        },
      ],
    });
    expect(body.messages[1].content).toBe(
      "[appa] Blocked: this call cannot run yet.",
    );
  });

  test("gives an interrupted notice its ruling even when the client recorded no result", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        { role: "user", content: "actually, never mind" },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    // The ruling joins the user turn that is already there rather than adding
    // a second one: Anthropic rejects two user messages in a row, and a
    // `tool_result` has to lead the turn answering its `tool_use`.
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "[appa] Blocked: this call cannot run yet.",
          is_error: true,
        },
        { type: "text", text: "actually, never mind" },
      ],
    });
    expect(body.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
  });

  test("re-inflates a cleared notice result with the ruling, and keeps a cleared ordinary result cleared", () => {
    // OpenCode truncates old tool results to `[Old tool result content
    // cleared]` inside the same session. The provider is owed the denial, so
    // the notice's cleared result gets the ruling back; an ordinary call's
    // cleared result is the client's own compression and stays cleared.
    const body = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
        { type: "function", function: { name: "read_file" } },
      ],
      messages: [
        { role: "user", content: "clean the build dir" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: NOTICE,
                arguments: JSON.stringify(
                  notice("shell", { command: "rm -rf build" }, "call_1"),
                ),
              },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "[Old tool result content cleared]",
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: "[Old tool result content cleared]",
        },
        { role: "user", content: "continue" },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });

    const assistant = body.messages[1] as {
      tool_calls: Array<{ function: { name: string; arguments: string } }>;
    };
    expect(assistant.tool_calls[0].function).toEqual({
      name: "shell",
      arguments: JSON.stringify({ command: "rm -rf build" }),
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "[appa] Blocked: this call cannot run yet.",
    });
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: "[Old tool result content cleared]",
    });
  });

  test("a Codex compaction turn restores the notices its summary is built from", () => {
    // Codex compaction is a turn of the same thread carrying the history the
    // summarizer compresses. The summarizer sees the calls the model actually
    // made and the rulings that answered them, never the notice envelope.
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      client_metadata: {
        session_id: "d12f967d-6fe1-4f92-a62f-0f6a2092fd2f",
        thread_id: "01a0859b-3029-78f3-a730-0edef60872cb",
        request_kind: "compaction",
      },
      input: [
        { role: "user", content: "clean the build dir" },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          status: "completed",
          arguments: JSON.stringify(
            notice("shell", { command: "rm -rf build" }, "call_1"),
          ),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "client text",
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "shell",
      status: "completed",
      arguments: JSON.stringify({ command: "rm -rf build" }),
    });
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "[appa] Blocked: this call cannot run yet.",
    });
  });

  test("an out-of-band compaction of another session's context still restores notices", () => {
    // A summarizer request stamped with a fresh session still carries the
    // original trajectory's sealed notices. Restoration is a function of the
    // body, not of which root the request binds, and it runs even when the
    // request declares no tools — the typical shape of an out-of-band
    // compaction. The provider is owed the original calls and the rulings.
    const body = {
      client_metadata: {
        session_id: "f5be22fa-3d3a-44ce-8d37-d0073acd5174",
        thread_id: "01a085a0-ca43-7671-9450-8508eddef38d",
        request_kind: "compaction",
      },
      input: [
        { role: "user", content: "clean the build dir" },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          status: "completed",
          arguments: JSON.stringify(
            notice("shell", { command: "rm -rf build" }, "call_1"),
          ),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "client text",
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      session: {
        sessionId: "01a085a0-ca43-7671-9450-8508eddef38d",
        provenance: "codex-turn-metadata",
      },
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "shell",
      status: "completed",
      arguments: JSON.stringify({ command: "rm -rf build" }),
    });
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "[appa] Blocked: this call cannot run yet.",
    });
  });

  test("leaves a client's own custom tool alone, even carrying notice-shaped arguments", () => {
    // A review argued a user-defined custom tool could be mistaken for a notice
    // and have its call rewritten — the denied call would then be executed by
    // whatever that tool does. Only a name ending in the notice tool's own
    // short name is ever a candidate, so an ordinary tool is not one.
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }, { name: "apply_patch" }],
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "apply_patch",
          input: JSON.stringify(notice("Bash", { command: "rm -rf /" })),
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: "patched 3 files",
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    // Untouched: same tool, same input, and its real result still its own.
    expect(body.input[0]).toEqual({
      type: "custom_tool_call",
      call_id: "call_1",
      name: "apply_patch",
      input: JSON.stringify(notice("Bash", { command: "rm -rf /" })),
    });
    expect(body.input[1]).toEqual({
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: "patched 3 files",
    });
  });

  test("leaves a foreign tool spelled like the notice alone when its record is not its own", () => {
    // Spelling alone is enough to *try* a call, because a notice proves itself
    // by its record. One whose record names another call belongs to someone else.
    const foreign = "someone_elses__get_remedy_plans";
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }, { name: foreign }],
      input: [
        {
          type: "function_call",
          call_id: "call_9",
          name: foreign,
          arguments: JSON.stringify(
            notice("Bash", { command: "ls" }, "toolu_1"),
          ),
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0].name).toBe(foreign);
  });

  test("keeps the ruling first in a user turn that already carries blocks", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "do this instead" }],
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "[appa] Blocked: this call cannot run yet.",
        is_error: true,
      },
      { type: "text", text: "do this instead" },
    ]);
  });

  test("still inserts a user turn when an assistant message follows the notice", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "continuing" }] },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(body.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(body.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "[appa] Blocked: this call cannot run yet.",
        is_error: true,
      },
    ]);
  });

  test("appends the ruling when the interrupted notice is the last thing in the history", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    // The provider is owed one result per call, and it must be the ruling.
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "[appa] Blocked: this call cannot run yet.",
          is_error: true,
        },
      ],
    });
  });

  test("does not duplicate tool_result if already present in a subsequent message", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_dup",
              name: NOTICE,
              input: notice("Bash", { command: "ls" }, "toolu_dup"),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_dup",
              content: "already present",
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(body.messages).toHaveLength(2);
    const results = (
      body.messages[1].content as Record<string, unknown>[]
    ).filter((b) => b.type === "tool_result" && b.tool_use_id === "toolu_dup");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe(
      "[appa] Blocked: this call cannot run yet.",
    );
  });

  test("answers a restored custom tool call with a custom tool call output", () => {
    const body = {
      // No custom declaration here on purpose: the notice's record is what says
      // this was a custom tool call, because the request carrying it back may
      // declare none.
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          arguments: JSON.stringify(
            notice("apply_patch", { input: "*** Begin Patch" }, "call_1", true),
          ),
        },
        { type: "function_call_output", call_id: "call_1", output: "shown" },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[1]).toEqual({
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: "[appa] Blocked: this call cannot run yet.",
    });
  });

  test("leaves a notice whose record names another call as the client recorded it, so the session goes on", () => {
    // Every later request carries this same history. Refusing it would end
    // the session for good over a presentation detail, so the call stays a
    // call to the notice tool with the result the client holds.
    const input = notice("Bash", { command: "rm -rf build" });
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_2", name: NOTICE, input }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: "what the client recorded",
            },
          ],
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(body.messages[0].content[0]).toEqual({
      type: "tool_use",
      id: "toolu_2",
      name: NOTICE,
      input,
    });
    expect(body.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_2",
      content: "what the client recorded",
    });
  });

  test("leaves a notice whose arguments are not a JSON object as the client recorded it", () => {
    // A client can hand back a notice with its arguments spelled as text that
    // is not JSON. There is no call to restore from it, and a throw here would
    // end the session over a record the client wrote.
    const input = {
      ...notice("Bash", { command: "ls" }, "toolu_3"),
      arguments: "not json at all",
    };
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_3", name: NOTICE, input }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_3", content: "seen" },
          ],
        },
      ],
    };

    expect(() =>
      prepareAppaRequest({
        body,
        interactionType: "anthropic:messages",
        canonicalizeToolName: canonicalize,
      }),
    ).not.toThrow();

    expect(body.messages[0].content[0]).toEqual({
      type: "tool_use",
      id: "toolu_3",
      name: NOTICE,
      input,
    });
  });

  test("leaves a malformed custom notice untouched instead of coercing its input", () => {
    const input = {
      ...notice("apply_patch", { input: "*** Begin Patch" }, "call_1", true),
      arguments: { input: { unexpected: "object" } },
    };
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
      ],
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: NOTICE,
          arguments: JSON.stringify(input),
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: NOTICE,
      arguments: JSON.stringify(input),
    });
  });

  test("restores a legacy custom notice whose arguments are JSON-object text", () => {
    const legacyArguments = JSON.stringify({ input: "*** Begin Patch\n" });
    const body = {
      tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: CONTROL },
        { type: "custom", name: "apply_patch" },
      ],
      input: [
        {
          type: "function_call",
          id: "fc_legacy",
          call_id: "call_legacy",
          name: NOTICE,
          arguments: JSON.stringify({
            tool: "apply_patch",
            arguments: legacyArguments,
            ruling: "[appa] Blocked: this call cannot run yet.",
            notice: { v: 1, call_id: "call_legacy", custom: true },
          }),
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0]).toEqual({
      type: "custom_tool_call",
      id: "ctc_legacy",
      call_id: "call_legacy",
      name: "apply_patch",
      input: "*** Begin Patch\n",
    });
  });

  test("a notice carries the ruling in the clear beside the call it was written for", () => {
    // A client-side judge reads a call's arguments, not the tool's result, so
    // the ruling has to be legible right here rather than encoded.
    expect(notice("Bash", { command: "rm -rf build" })).toEqual({
      tool: "Bash",
      arguments: { command: "rm -rf build" },
      ruling: "[appa] Blocked: this call cannot run yet.",
      notice: { v: 1, call_id: "toolu_1" },
    });
  });
});

describe("APPA request preflight", () => {
  test("hides the notice tool from the provider and keeps the control tool", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }, { name: "Bash" }],
      messages: [{ role: "user", content: "hello" }],
    };

    const prepared = prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(body.tools).toEqual([{ name: CONTROL }, { name: "Bash" }]);
    expect(prepared.tools).toEqual({
      controlToolName: CONTROL,
      noticeToolName: NOTICE,
    });
    expect(prepared.promptOperationId).toBeDefined();
  });

  test("injects the missing notice tool using the client's control-tool prefix", () => {
    const body = { tools: [{ name: CONTROL }, { name: "Bash" }], messages: [] };
    const prepared = prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });
    expect(prepared.tools).toEqual({
      controlToolName: CONTROL,
      noticeToolName: NOTICE,
    });
  });

  test("injects both APPA tools when the client declared none of them", () => {
    const body = { tools: [{ name: "Bash" }], messages: [] };
    const prepared = prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });
    expect(prepared.tools?.noticeToolName).toMatch(/get_remedy_plans$/);
    expect(prepared.tools?.controlToolName).toMatch(/execute_remedy_plan$/);
  });

  test("refuses Azure Responses tool traffic before it can bypass governance", () => {
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }, { name: "read" }],
      input: [],
    };

    expect(() =>
      prepareAppaRequest({
        body,
        interactionType: "azure:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("Use Azure Chat Completions");
    expect(body.tools).toEqual([
      { name: NOTICE },
      { name: CONTROL },
      { name: "read" },
    ]);
  });

  test("refuses a second spelling of an APPA tool, and says what to do", () => {
    // The same gateway registered twice in one client declares the control
    // tool under two names that both resolve to it; the session would not
    // know which name to render or which call to trust, so it is refused
    // with the way out.
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { name: NOTICE },
            { name: CONTROL },
            { name: "archestra__execute_remedy_plan" },
          ],
          messages: [],
        },
        interactionType: "anthropic:messages",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("one gateway of this platform at a time");
  });

  test("leaves a lookalike pair under a label the canonicalizer does not anchor foreign", () => {
    // A hostile MCP server can put the branded names on its own tools. Built-in
    // status comes only from a label tied to one of this organization's own
    // gateways, so under any other label the pair is two foreign tools and the
    // session is admitted without an APPA tool binding.
    const prepared = prepareAppaRequest({
      body: {
        tools: [
          { name: "mcp__evil__archestra__get_remedy_plans" },
          { name: "mcp__evil__archestra__execute_remedy_plan" },
        ],
        messages: [],
      },
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });
    expect(prepared.tools?.noticeToolName).toBe("archestra__get_remedy_plans");
    expect(prepared.tools?.controlToolName).toBe(
      "archestra__execute_remedy_plan",
    );
  });

  describe("Codex namespaces", () => {
    test("keeps unanchored platform calls foreign without renaming host tools", () => {
      expect(namespacedToolName("archestra__execute_remedy_plan", "evil")).toBe(
        "evil__archestra__execute_remedy_plan",
      );
      expect(namespacedToolName("shell", "functions")).toBe("shell");
      expect(namespacedToolName(CONTROL, "functions")).toBe(CONTROL);
      expect(
        namespacedToolName("archestra__execute_remedy_plan", undefined),
      ).toBe("archestra__execute_remedy_plan");
    });
    // Codex declares each MCP server's tools as members of its
    // `mcp__<server>` namespace, under their bare names, so any server can
    // declare a member named like the platform's notice and control tools.
    // Only the gateway's namespace declares the platform's: the notice tool's
    // namespace is where every denied call's arguments are delivered.
    const gatewayOnly = (name: string) =>
      name.startsWith("mcp__gateway__")
        ? name.slice("mcp__gateway__".length)
        : name;
    const pairIn = (namespace: string) => ({
      type: "namespace",
      name: namespace,
      tools: [
        { type: "function", name: "archestra__get_remedy_plans" },
        { type: "function", name: "archestra__execute_remedy_plan" },
      ],
    });

    test("binds the pair the gateway's namespace declares, not a lookalike's declared before it", () => {
      const prepared = prepareAppaRequest({
        body: {
          tools: [pairIn("mcp__lookalike"), pairIn("mcp__gateway")],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: gatewayOnly,
      });

      expect(prepared.tools).toEqual({
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
        controlNamespace: "mcp__gateway",
        noticeNamespace: "mcp__gateway",
      });
    });

    test.each([
      "mcp__lookalike",
      "evil",
      "functions",
    ])("a bare pair in %s is not gateway-anchored: the proxy injects its own", (namespace) => {
      const body = { tools: [pairIn(namespace)], input: [] };

      const prepared = prepareAppaRequest({
        body,
        interactionType: "openai:responses",
        canonicalizeToolName: gatewayOnly,
      });

      expect(prepared.tools).toEqual({
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      });
      expect(body.tools).toContainEqual({
        type: "function",
        name: "archestra__execute_remedy_plan",
        parameters: { type: "object", properties: {} },
      });
    });

    test("injects a trusted control when foreign tools exist only in a nested input item", () => {
      const body: { input: unknown[]; tools?: unknown[] } = {
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [pairIn("functions")],
          },
        ],
      };
      const prepared = prepareAppaRequest({
        body,
        interactionType: "openai:responses",
        canonicalizeToolName: gatewayOnly,
      });

      expect(prepared.tools).toEqual({
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      });
      // The notice is proxy-issued, not model-callable; only control remains.
      expect(body.tools).toEqual([
        {
          type: "function",
          name: "archestra__execute_remedy_plan",
          parameters: { type: "object", properties: {} },
        },
      ]);
    });

    test("refuses the pair declared in two gateways' namespaces", () => {
      expect(() =>
        prepareAppaRequest({
          body: {
            tools: [pairIn("mcp__gateway"), pairIn("mcp__second_gateway")],
            input: [],
          },
          interactionType: "openai:responses",
          canonicalizeToolName: (name) =>
            gatewayOnly(
              name.replace(/^mcp__second_gateway__/, "mcp__gateway__"),
            ),
        }),
      ).toThrow("one gateway of this platform at a time");
    });
  });

  test("governs a wire family it cannot restore notices on, instead of refusing it", () => {
    // Gemini, Bedrock, Cohere and native Ollama have no restoration; calls and
    // results are still ruled on, and a notice stays as the notice call. The
    // tools are declared in each family's own shape.
    const input = notice("Bash", { command: "ls" }, "call_g");
    const gemini = {
      tools: [
        {
          functionDeclarations: [
            { name: NOTICE },
            { name: CONTROL },
            { name: "read" },
          ],
        },
      ],
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: NOTICE, args: input } }],
        },
      ],
    };
    const prepared = prepareAppaRequest({
      body: gemini,
      interactionType: "gemini:generateContent",
      canonicalizeToolName: canonicalize,
    });
    expect(prepared.tools?.controlToolName).toBe(CONTROL);
    expect(prepared.promptOperationId).toBeUndefined();
    expect(gemini.contents[0].parts[0].functionCall.name).toBe(NOTICE);
    // The model never sees the notice tool, in this shape either.
    expect(gemini.tools[0].functionDeclarations.map((t) => t.name)).toEqual([
      CONTROL,
      "read",
    ]);

    const bedrock = {
      toolConfig: {
        tools: [
          { toolSpec: { name: NOTICE } },
          { toolSpec: { name: CONTROL } },
        ],
      },
      messages: [],
    };
    expect(
      prepareAppaRequest({
        body: bedrock,
        interactionType: "bedrock:converse",
        canonicalizeToolName: canonicalize,
      }).tools?.controlToolName,
    ).toBe(CONTROL);
    expect(bedrock.toolConfig.tools.map((t) => t.toolSpec.name)).toEqual([
      CONTROL,
    ]);
  });

  test("reads every declaration shape the families use, and strips the notice tool from each", () => {
    // Codex groups a server's tools under a namespace whose members keep
    // their own names; Gemini may send one tool object instead of a list;
    // Chat Completions names a free-form tool under `custom`.
    const codex = {
      tools: [
        {
          type: "namespace",
          name: "gateway",
          tools: [{ name: NOTICE }, { name: CONTROL }, { name: "read" }],
        },
      ],
      input: [],
    };
    const prepared = prepareAppaRequest({
      body: codex,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });
    expect(prepared.tools?.controlToolName).toBe(CONTROL);
    expect(codex.tools[0].tools.map((t) => t.name)).toEqual([CONTROL, "read"]);

    const gemini = {
      tools: { functionDeclarations: [{ name: NOTICE }, { name: CONTROL }] },
      contents: [],
    } as { tools: unknown; contents: unknown[] };
    expect(
      prepareAppaRequest({
        body: gemini,
        interactionType: "gemini:generateContent",
        canonicalizeToolName: canonicalize,
      }).tools?.controlToolName,
    ).toBe(CONTROL);
    expect(gemini.tools).toEqual([
      { functionDeclarations: [{ name: CONTROL }] },
    ]);

    const chat = {
      tools: [
        { type: "function", function: { name: NOTICE } },
        { type: "function", function: { name: CONTROL } },
        {
          type: "custom",
          custom: { name: "apply_patch", format: { type: "text" } },
        },
      ],
      messages: [],
    };
    const chatPrepared = prepareAppaRequest({
      body: chat,
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: canonicalize,
    });
    expect(chatPrepared.customTools.has("apply_patch")).toBe(true);
    expect(chat.tools.map((t) => declaredToolName(t))).toEqual([
      CONTROL,
      "apply_patch",
    ]);
  });

  test("treats Bedrock InvokeModel as the Anthropic Messages family it carries", () => {
    expect(appaWireFamily("bedrock:invoke")).toBe("anthropic:messages");
    expect(appaWireFamily("bedrock:converse")).toBeUndefined();
  });

  test("restores only explicitly audited provider interaction types", () => {
    expect(appaWireFamily("github-copilot:responses")).toBe("openai:responses");
    expect(appaWireFamily("azure:chatCompletions")).toBe(
      "openai:chatCompletions",
    );
    expect(appaWireFamily("azure:responses")).toBeUndefined();
    expect(appaWireFamily("future:responses")).toBeUndefined();
  });

  test("anchors OpenCode's label form to a gateway the canonicalizer knows", () => {
    // OpenCode declares `<label>_<branded>`, which the canonicalizer does not
    // read; the label counts when the canonicalizer anchors it in the form it
    // does read, and a label it does not know leaves the pair foreign.
    const anchored = (name: string) =>
      name.startsWith("mcp__my_gateway__")
        ? name.slice("mcp__my_gateway__".length)
        : name;
    const prepared = prepareAppaRequest({
      body: {
        tools: [
          { name: "my_gateway_archestra__get_remedy_plans" },
          { name: "my_gateway_archestra__execute_remedy_plan" },
        ],
        messages: [],
      },
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: anchored,
    });
    expect(prepared.tools?.controlToolName).toBe(
      "my_gateway_archestra__execute_remedy_plan",
    );
    expect(prepared.spellings.get("archestra__execute_remedy_plan")).toBe(
      "my_gateway_archestra__execute_remedy_plan",
    );
    const foreign = prepareAppaRequest({
      body: {
        tools: [
          { name: "evil_archestra__get_remedy_plans" },
          { name: "evil_archestra__execute_remedy_plan" },
        ],
        messages: [],
      },
      interactionType: "openai:chatCompletions",
      canonicalizeToolName: anchored,
    });
    expect(foreign.tools?.noticeToolName).toMatch(/get_remedy_plans$/);
    expect(foreign.tools?.controlToolName).toMatch(/execute_remedy_plan$/);
  });

  test("refuses a session that defers its tools to a tool search", () => {
    // Codex declares a client-run `tool_search` for MCP tools on models that
    // support it: the APPA tools are then never on the wire.
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: "exec_command" },
            { type: "tool_search", execution: "client", parameters: {} },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("defers its tools to a tool search");
  });

  test("refuses a provider-hosted tool this proxy never sees called", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { name: NOTICE },
            { name: CONTROL },
            { type: "web_search_20250305", name: "web_search" },
          ],
          messages: [],
        },
        interactionType: "anthropic:messages",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("provider-hosted tool");
  });

  test("governs a Responses web search by its result instead of refusing the session", () => {
    const prepared = prepareAppaRequest({
      body: {
        tools: [
          { type: "function", name: NOTICE },
          { type: "function", name: CONTROL },
          { type: "web_search" },
        ],
        input: [],
      },
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(prepared.tools).toEqual({
      controlToolName: CONTROL,
      noticeToolName: NOTICE,
    });
  });

  test("still refuses a hosted tool that acts, whose call a withheld result cannot undo", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: NOTICE },
            { type: "function", name: CONTROL },
            { type: "mcp", server_label: "remote" },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow(ApiError);
  });

  test("refuses Codex code mode, where calls are wrapped in exec", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: NOTICE },
            { type: "function", name: CONTROL },
          ],
          additional_tools: [
            { type: "custom", name: "exec", format: { type: "grammar" } },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("direct tool mode only");
  });

  test("refuses grammar exec declared in ordinary tools without origin metadata", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: NOTICE },
            { type: "function", name: CONTROL },
            { type: "custom", name: "exec", format: { type: "grammar" } },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("direct tool mode only");
  });

  test("refuses historic custom exec calls even without a grammar declaration", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: NOTICE },
            { type: "function", name: CONTROL },
            { type: "custom", name: "exec" },
          ],
          input: [
            {
              type: "custom_tool_call",
              call_id: "historic_exec",
              name: "exec",
              input: "wrapped tool invocation",
            },
          ],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).toThrow("direct tool mode only");
  });

  test("allows a plain foreign custom exec declaration without grammar or history", () => {
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [
            { type: "function", name: NOTICE },
            { type: "function", name: CONTROL },
            { type: "custom", name: "exec" },
          ],
          input: [],
        },
        interactionType: "openai:responses",
        canonicalizeToolName: canonicalize,
      }),
    ).not.toThrow();
  });

  test("strips the notice tool from the Responses additional_tools container too", () => {
    const body = {
      tools: [{ type: "function", name: CONTROL }],
      additional_tools: [
        { type: "function", name: NOTICE },
        { type: "function", name: "shell" },
      ],
      input: [],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.additional_tools).toEqual([
      { type: "function", name: "shell" },
    ]);
  });

  test("reads and strips tools declared in a Responses additional_tools input item", () => {
    // Codex drives some models over the lite Responses wire, which declares
    // the tools as an input item instead of a top-level container.
    const body = {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                { type: "function", name: NOTICE },
                { type: "function", name: CONTROL },
                { type: "function", name: "exec_command" },
              ],
            },
          ],
        },
        { type: "message", role: "user", content: "hi" },
      ],
    };

    const prepared = prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(prepared.tools?.controlToolName).toBe(CONTROL);
    expect(body.input[0].tools?.[0].tools.map((t) => t.name)).toEqual([
      CONTROL,
      "exec_command",
    ]);
    expect(prepared.namespaces.get("exec_command")).toBe("functions");
    expect(prepared.namespaces.get(CONTROL)).toBe("functions");
  });

  test("restores a namespaced Codex call under its namespace, and a custom call's output under a custom output id", () => {
    // The provider checks that a call in the history names the namespace its
    // tool was declared in, and that an output's item id is of its kind. A
    // client echoes the notice call under the notice tool's namespace, or
    // none, and answers it with a function call output under an `fco_` id.
    const body = {
      tools: [{ name: NOTICE }, { name: CONTROL }],
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: NOTICE,
          namespace: "mcp__gateway",
          arguments: JSON.stringify(
            buildNoticeArguments({
              id: "call_1",
              tool: "spawn_agent",
              arguments: { message: "list the files" },
              result: "[appa] Refused: no plan.",
              namespace: "multi_agent_v1",
            }),
          ),
        },
        {
          type: "function_call_output",
          id: "fco_1",
          call_id: "call_1",
          output: "[appa] Refused: no plan.",
        },
        {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          name: NOTICE,
          arguments: JSON.stringify(
            buildNoticeArguments({
              id: "call_2",
              tool: "apply_patch",
              arguments: { input: "*** Begin Patch" },
              result: "[appa] Blocked: this call cannot run yet.",
              custom: true,
            }),
          ),
        },
        {
          type: "function_call_output",
          id: "fco_2",
          call_id: "call_2",
          output: "[appa] Blocked: this call cannot run yet.",
        },
      ],
    };

    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      canonicalizeToolName: canonicalize,
    });

    expect(body.input[0]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "spawn_agent",
      namespace: "multi_agent_v1",
      arguments: JSON.stringify({ message: "list the files" }),
    });
    expect(body.input[1]).toEqual({
      type: "function_call_output",
      id: "fco_1",
      call_id: "call_1",
      output: "[appa] Refused: no plan.",
    });
    expect(body.input[2]).toEqual({
      type: "custom_tool_call",
      id: "ctc_2",
      call_id: "call_2",
      name: "apply_patch",
      input: "*** Begin Patch",
    });
    expect(body.input[3]).toEqual({
      type: "custom_tool_call_output",
      id: "ctco_2",
      call_id: "call_2",
      output: "[appa] Blocked: this call cannot run yet.",
    });
  });

  test("opens no root for a request that declares no tools, but still restores its history", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: NOTICE,
              input: notice("Bash", { command: "rm -rf build" }),
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "held" },
          ],
        },
      ],
    };

    const prepared = prepareAppaRequest({
      body,
      interactionType: "anthropic:messages",
      canonicalizeToolName: canonicalize,
    });

    expect(prepared.tools).toBeUndefined();
    expect(prepared.promptOperationId).toBeUndefined();
    expect(
      (body.messages[0].content as Record<string, unknown>[])[0].name,
    ).toBe("Bash");
  });

  test("reports a user turn only when the user spoke last", () => {
    const turn = (last: unknown) =>
      prepareAppaRequest({
        body: {
          tools: [{ name: NOTICE }, { name: CONTROL }],
          messages: [{ role: "user", content: "go" }, last],
        },
        interactionType: "anthropic:messages",
        canonicalizeToolName: canonicalize,
      }).promptOperationId;

    expect(turn({ role: "user", content: "again" })).toBeDefined();
    expect(
      turn({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: "output" },
        ],
      }),
    ).toBeUndefined();
  });

  test("uses a semantic turn digest when request object keys are reordered", () => {
    const first = appaTurnBoundaries({
      family: "openai:responses",
      body: {
        tools: [{ type: "function", name: CONTROL }],
        input: [{ type: "message", role: "user", content: "go" }],
      },
    });
    const reordered = appaTurnBoundaries({
      family: "openai:responses",
      body: {
        input: [{ content: "go", role: "user", type: "message" }],
        tools: [{ name: CONTROL, type: "function" }],
      },
    });

    expect(reordered).toEqual(first);
  });
});

function notice(
  tool: string,
  args: Record<string, unknown>,
  id = "toolu_1",
  custom = false,
) {
  return buildNoticeArguments({
    id,
    tool,
    arguments: args,
    result: "[appa] Blocked: this call cannot run yet.",
    ...(custom ? { custom: true } : {}),
  });
}

describe("client session identity", () => {
  // Captured from a real `claude --print` run against a recording proxy: the
  // CLI sends its session id as a header and repeats it inside metadata.
  const CLAUDE_SESSION = "74582997-cc91-4cd5-baee-676e581ca028";
  const claudeMetadata = {
    user_id: JSON.stringify({
      device_id: "3d8b2867632db5c0",
      account_uuid: "",
      session_id: CLAUDE_SESSION,
    }),
  };

  test("leaves Claude Code's session header to the client adapter", () => {
    // The wire module reads only generic fields; the Claude Code adapter owns
    // the client-specific header (session-identity.test.ts proves the pair
    // binds the same session).
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: { metadata: claudeMetadata },
        headers: { "x-claude-code-session-id": CLAUDE_SESSION },
      }),
    ).toMatchObject({
      sessionId: CLAUDE_SESSION,
      parentId: undefined,
      provenance: "claude-metadata",
    });
  });

  test("falls back to the session inside metadata.user_id", () => {
    // Same run without the header — the body still identifies the session, so
    // a client needs no OpenAPPA-specific configuration either way.
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: { metadata: claudeMetadata },
        headers: {},
      }),
    ).toMatchObject({
      sessionId: CLAUDE_SESSION,
      parentId: undefined,
      provenance: "claude-metadata",
    });
  });

  test("reads the older user_…_session_<uuid> metadata form the proxy log reads", () => {
    // The proxy log reads this form too, so both records name one session.
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: {
          metadata: {
            user_id: `user_abc_account_def_session_${CLAUDE_SESSION}`,
          },
        },
        headers: {},
      }).sessionId,
    ).toBe(CLAUDE_SESSION);
  });

  test("keeps an opaque metadata.user_id as the session", () => {
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: { metadata: { user_id: "tenant-42" } },
        headers: {},
      }).sessionId,
    ).toBe("tenant-42");
  });

  test.each([
    ["prompt_cache_key", { prompt_cache_key: "codex-conv-1" }, "codex-conv-1"],
    ["metadata.session_id", { metadata: { session_id: "s-2" } }, "s-2"],
    ["conversation", { conversation: "conv-3" }, "conv-3"],
  ])("reads an OpenAI-family session from %s", (_label, body, expected) => {
    expect(
      appaSessionIdentity({
        family: "openai:responses",
        body,
        headers: {},
      }).sessionId,
    ).toBe(expected);
  });

  test("uses OpenCode's session header before OpenAI body fallbacks", () => {
    expect(
      appaSessionIdentity({
        family: "openai:chatCompletions",
        body: {
          prompt_cache_key: "cache-session",
          metadata: { session_id: "metadata-session" },
          conversation: "conversation-session",
        },
        headers: { "x-opencode-session": "opencode-session" },
      }),
    ).toMatchObject({
      sessionId: "opencode-session",
      provenance: "opencode-session",
    });
  });

  test("an explicit header outranks anything the body says", () => {
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: { metadata: claudeMetadata },
        headers: {
          "x-appa-session-id": "chat-conversation",
          "x-appa-parent-id": "parent-root",
          "x-claude-code-session-id": CLAUDE_SESSION,
        },
      }),
    ).toMatchObject({
      sessionId: "chat-conversation",
      parentId: "parent-root",
      provenance: "appa-header",
    });
  });

  test("keeps the explicit OpenAPPA session over OpenCode's session header", () => {
    expect(
      appaSessionIdentity({
        family: "openai:responses",
        body: {},
        headers: {
          "x-appa-session-id": "appa-session",
          "x-opencode-session": "opencode-session",
        },
      }),
    ).toMatchObject({
      sessionId: "appa-session",
      provenance: "appa-header",
    });
  });

  test("reports nothing when the client identifies no session", () => {
    // The caller binds a fallback root; refusing the request is what broke
    // every client the Connect page configures.
    expect(
      appaSessionIdentity({
        family: "openai:chatCompletions",
        body: { messages: [] },
        headers: {},
      }),
    ).toMatchObject({
      parentId: undefined,
      provenance: "none",
    });
  });

  test("keeps opaque metadata over an unread client header", () => {
    expect(
      appaSessionIdentity({
        family: "anthropic:messages",
        body: { metadata: { user_id: "opaque-account-field" } },
        headers: { "x-claude-code-session-id": "claude-session" },
      }),
    ).toMatchObject({
      sessionId: "opaque-account-field",
      provenance: "claude-metadata",
    });
  });

  test("keeps the established cache-key precedence over conversation", () => {
    const session = appaSessionIdentity({
      family: "openai:responses",
      body: {
        prompt_cache_key: "conversation-a",
        conversation: "conversation-b",
      },
      headers: {},
    });

    expect(session).toMatchObject({
      sessionId: "conversation-a",
      provenance: "prompt-cache-key",
    });
    expect(() =>
      prepareAppaRequest({
        body: {
          tools: [{ name: NOTICE }, { name: CONTROL }],
          messages: [],
        },
        interactionType: "openai:chatCompletions",
        session,
        canonicalizeToolName: canonicalize,
      }),
    ).not.toThrow();
  });
});

describe("canonicalJson", () => {
  test("deterministically sorts keys and formats arrays", () => {
    expect(canonicalJson({ b: 2, a: 1, c: [3, 2, 1] })).toBe(
      '{"a":1,"b":2,"c":[3,2,1]}',
    );
  });

  test("omits undefined, symbol, and function properties in objects and replaces them with null in arrays", () => {
    expect(
      canonicalJson({
        a: 1,
        b: undefined,
        c: () => {},
        d: Symbol("test"),
        arr: [1, undefined, () => {}, Symbol("test"), 2],
      }),
    ).toBe('{"a":1,"arr":[1,null,null,null,2]}');
  });

  test("bounds recursion depth and emits depth-exceeded placeholder", () => {
    const deeplyNested = {
      level1: {
        level2: {
          level3: {
            level4: "deep",
          },
        },
      },
    };
    expect(canonicalJson(deeplyNested, { maxDepth: 2 })).toBe(
      '{"level1":{"level2":"[depth-exceeded]"}}',
    );
  });

  test("bounds serialized size and emits size-exceeded placeholder", () => {
    const largeObject = {
      key1: "first long value here",
      key2: "second long value here",
      key3: "third long value here",
    };
    const result = canonicalJson(largeObject, { maxBytes: 30 });
    expect(result).toContain("[size-exceeded]");
  });

  test("does not double-count bytes for nested arrays and objects", () => {
    const data = { nested: { arr: ["a", "b"] } };
    const serialized = '{"nested":{"arr":["a","b"]}}';
    expect(canonicalJson(data, { maxBytes: serialized.length })).toBe(
      serialized,
    );
    expect(canonicalJson(data, { maxBytes: serialized.length - 1 })).toContain(
      "[size-exceeded]",
    );
  });

  test("handles circular references gracefully without throwing RangeError", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => canonicalJson(circular)).not.toThrow();
    const result = canonicalJson(circular);
    expect(result).toContain("[depth-exceeded]");
  });
});
