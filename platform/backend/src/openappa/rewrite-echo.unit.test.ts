import { describe, expect, test } from "vitest";
import {
  captureRewriteCalls,
  captureRewriteEcho,
  type RewriteBytes,
  recordRewriteCalls,
  recordRewriteText,
  restoreRewriteCalls,
  restoreRewriteText,
  rewriteEchoKeys,
  rewriteTextKey,
} from "./rewrite-echo";
import { rewriteOrigin } from "./rewrite-projection";
import { stampToolCallId } from "./trajectory-stamp";

describe("exact APPA echo replay", () => {
  test("restores raw argument spelling, provider fields, namespace, and result IDs", () => {
    const family = "openai:responses";
    const original = {
      type: "custom_tool_call",
      id: "ctc_original",
      call_id: "call_original",
      name: "shell",
      namespace: "functions",
      input: "  printf '%s\\n' '\\u0061'\r\n",
      status: "completed",
      provider_extension: { signed: "opaque" },
    };
    const response = {
      output: [
        {
          type: "function_call",
          id: "fc_notice",
          call_id: "client_call",
          name: "archestra__get_remedy_plans",
          arguments: '{"ruling":"blocked"}',
        },
      ],
    };
    const pairs = recordRewriteCalls({
      family,
      response,
      originals: captureRewriteCalls({
        family,
        response: { output: [original] },
      }),
      emitted: [{ id: original.call_id, wireId: "client_call" }],
      recorded: new Map(),
    });
    const clientRequest = { input: structuredClone(response.output) };
    const target = {
      input: [
        {
          type: "custom_tool_call",
          call_id: original.call_id,
          name: "shell",
          input: "lossy reconstruction",
        },
        {
          type: "custom_tool_call_output",
          call_id: "client_call",
          output: "Blocked by policy",
        },
      ],
    };
    restoreRewriteCalls({
      family,
      clientRequest,
      providerRequest: target,
      recorded: records(pairs),
    });
    expect(JSON.stringify(target.input[0])).toBe(JSON.stringify(original));
    expect(target.input[1]).toEqual({
      type: "custom_tool_call_output",
      call_id: original.call_id,
      output: "Blocked by policy",
    });
  });

  test("restores Chat argument string bytes after client JSON normalization", () => {
    const family = "openai:chatCompletions";
    const original = {
      id: "call_original",
      type: "function",
      function: { name: "read", arguments: '{ "path" : "\\u0061", "n":1e0 }' },
      thought_signature: "unchanged",
    };
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "client_call",
                type: "function",
                function: { name: "read", arguments: '{"path":"a","n":1}' },
              },
            ],
          },
        },
      ],
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response,
        originals: captureRewriteCalls({
          family,
          response: { choices: [{ message: { tool_calls: [original] } }] },
        }),
        emitted: [{ id: original.id, wireId: "client_call" }],
        recorded: new Map(),
      }),
    );
    const clientRequest = { messages: [response.choices[0].message] };
    const target = structuredClone(clientRequest);
    for (let iteration = 0; iteration < 3; iteration++) {
      restoreRewriteCalls({
        family,
        clientRequest,
        providerRequest: target,
        recorded: saved,
      });
      expect(JSON.stringify(target.messages[0].tool_calls[0])).toBe(
        JSON.stringify(original),
      );
    }
  });

  test("rejects changed approval or renderer output instead of restoring an old grant", () => {
    const family = "anthropic:messages";
    const original = {
      type: "tool_use",
      id: "original",
      name: "question",
      input: { question: "Choose", choices: ["A", "B"] },
    };
    const originals = captureRewriteCalls({
      family,
      response: { content: [original] },
    });
    const first = {
      content: [
        { ...original, id: "question_version_one", name: "native_question" },
      ],
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response: first,
        originals,
        emitted: [{ id: "original", wireId: "question_version_one" }],
        recorded: new Map(),
      }),
    );
    const future = {
      content: [
        { ...original, id: "question_version_two", name: "different_question" },
      ],
    };
    expect(() =>
      recordRewriteCalls({
        family,
        response: future,
        originals,
        emitted: [{ id: "original", wireId: "question_version_two" }],
        recorded: saved,
      }),
    ).toThrow("differs from its recorded representation");
    expect(future.content[0].name).toBe("different_question");
    const denied = {
      content: [
        {
          type: "tool_use",
          id: "question_version_one",
          name: "archestra__get_remedy_plans",
          input: { ruling: "New policy denies this call" },
        },
      ],
    };
    expect(() =>
      recordRewriteCalls({
        family,
        response: denied,
        originals,
        emitted: [{ id: "original", wireId: "question_version_one" }],
        recorded: saved,
      }),
    ).toThrow("differs from its recorded representation");
    expect(denied.content[0].name).toBe("archestra__get_remedy_plans");
  });

  test("rejects modified echoes without replacing an approved result", () => {
    const family = "anthropic:messages";
    const original = {
      type: "tool_use",
      id: "original",
      name: "read",
      input: { path: "a" },
    };
    const response = { content: [{ ...original, id: "client" }] };
    const saved = records(
      recordRewriteCalls({
        family,
        response,
        originals: captureRewriteCalls({
          family,
          response: { content: [original] },
        }),
        emitted: [{ id: "original", wireId: "client" }],
        recorded: new Map(),
      }),
    );
    const clientRequest = {
      messages: [
        {
          role: "assistant",
          content: [{ ...response.content[0], input: { path: "changed" } }],
        },
      ],
    };
    const target = structuredClone(clientRequest);
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest,
        providerRequest: target,
        recorded: saved,
      }),
    ).toThrow("does not match");
    expect(target).toEqual(clientRequest);
  });

  test("fails explicitly when a rewritten call has no retained pair", () => {
    const family = "openai:responses";
    const request = {
      input: [
        {
          type: "function_call",
          call_id: stampToolCallId({
            callId: "call_original",
            sessionId: "session",
            organizationId: "org",
            callerId: "caller",
            secret: "secret",
          }),
          name: "read",
          arguments: "{}",
        },
      ],
    };
    expect(rewriteEchoKeys({ family, request })).toHaveLength(2);
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: request,
        providerRequest: structuredClone(request),
        recorded: new Map(),
      }),
    ).toThrow("missing or expired");
  });

  test("does not reject an inert tool name or a malformed stamp prefix", () => {
    const family = "openai:responses";
    const request = {
      input: [
        {
          type: "function_call",
          call_id: "appat1expiredinvalidshape",
          name: "vendor__get_remedy_plans",
          arguments: '{"path":"a"}',
        },
      ],
    };
    const provider = structuredClone(request);
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: request,
        providerRequest: provider,
        recorded: new Map(),
      }),
    ).not.toThrow();
    expect(provider).toEqual(request);
  });

  test("fails a syntactically valid notice that was never recorded", () => {
    const family = "anthropic:messages";
    const request = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_notice",
              name: "read",
              input: {
                tool: "read",
                arguments: { path: "a" },
                ruling: "denied",
                notice: { v: 1, call_id: "toolu_notice" },
              },
            },
          ],
        },
      ],
    };
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: request,
        providerRequest: structuredClone(request),
        recorded: new Map(),
      }),
    ).toThrow("missing or expired");
  });

  test("rejects a reused provider id with different original bytes", () => {
    const family = "anthropic:messages";
    const denied = {
      type: "tool_use",
      id: "toolu_test_weather",
      name: "archestra__run_tool",
      input: { tool_name: "grain__list_meetings", tool_args: { limit: 5 } },
    };
    const notice = {
      type: "tool_use",
      id: "toolu_test_weather",
      name: "archestra__get_remedy_plans",
      input: { ruling: "blocked", tool: "grain__list_meetings" },
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response: { content: [notice] },
        originals: captureRewriteCalls({
          family,
          response: { content: [denied] },
        }),
        emitted: [{ id: denied.id }],
        recorded: new Map(),
      }),
    );
    const before = [...saved.values()].map((pair) => pair.original.toString());
    expect(() =>
      recordRewriteCalls({
        family,
        response: {
          content: [
            {
              type: "tool_use",
              id: "toolu_test_weather",
              name: "archestra__execute_remedy_plan",
              input: { offer_id: "test-offer" },
            },
          ],
        },
        originals: captureRewriteCalls({
          family,
          response: {
            content: [
              {
                type: "tool_use",
                id: "toolu_test_weather",
                name: "archestra__execute_remedy_plan",
                input: { offer_id: "test-offer" },
              },
            ],
          },
        }),
        emitted: [{ id: "toolu_test_weather" }],
        recorded: saved,
      }),
    ).toThrow("reused a replay identity");
    expect([...saved.values()].map((pair) => pair.original.toString())).toEqual(
      before,
    );
  });

  test("restores by origin stamp when a prior restore replaced the call id", () => {
    const family = "anthropic:messages";
    const original = JSON.parse(
      '{"type":"tool_use","id":"toolu_provider","name":"read","input":{"path":"a"},"__proto__":{"admin":true}}',
    );
    const echoed = {
      type: "tool_use",
      id: "client_call",
      name: "archestra__get_remedy_plans",
      input: { ruling: "blocked" },
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response: { content: [echoed] },
        originals: captureRewriteCalls({
          family,
          response: { content: [JSON.parse(JSON.stringify(original))] },
        }),
        emitted: [{ id: original.id, wireId: "client_call" }],
        recorded: new Map(),
      }),
    );
    const holder = {
      type: "tool_use",
      id: "client_call",
      name: "archestra__get_remedy_plans",
      input: { ruling: "blocked" },
    };
    const body = { messages: [{ role: "assistant", content: [holder] }] };
    const echo = captureRewriteEcho({ family, body });
    Object.defineProperty(holder, rewriteOrigin, {
      value: { v: 1, id: 4 },
      enumerable: true,
    });
    const derived = { ...holder, id: "hitl_replaced" };
    const providerRequest = {
      messages: [
        { role: "assistant", content: [derived] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "hitl_replaced",
              content: "APPROVED",
            },
          ],
        },
      ],
    };
    const references = restoreRewriteCalls({
      family,
      clientRequest: echo.request,
      providerRequest,
      recorded: saved,
      sources: echo.sources,
    });
    expect(JSON.stringify(derived)).toBe(JSON.stringify(original));
    expect(providerRequest.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: original.id,
      content: "APPROVED",
    });
    expect(references.get("hitl_replaced")).toBe(original.id);
    expect(
      Object.getOwnPropertyDescriptor(derived, "__proto__")?.value,
    ).toEqual({
      admin: true,
    });
    expect("admin" in derived).toBe(false);
  });

  test("uses the stamped parent when two restored calls share an id", () => {
    const family = "anthropic:messages";
    const first = {
      type: "tool_use",
      id: "toolu_shared",
      name: "archestra__run_tool",
      input: { tool_name: "grain__list_meetings" },
    };
    const firstEcho = {
      type: "tool_use",
      id: "toolu_shared",
      name: "archestra__get_remedy_plans",
      input: { ruling: "blocked" },
    };
    const second = {
      type: "tool_use",
      id: "toolu_remedy",
      name: "archestra__execute_remedy_plan",
      input: { offer_id: "test-offer" },
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response: { content: [firstEcho] },
        originals: captureRewriteCalls({
          family,
          response: { content: [first] },
        }),
        emitted: [{ id: first.id }],
        recorded: new Map(),
      }),
    );
    for (const pair of recordRewriteCalls({
      family,
      response: { content: [second] },
      originals: captureRewriteCalls({
        family,
        response: { content: [second] },
      }),
      emitted: [{ id: second.id }],
      recorded: saved,
    }))
      saved.set(pair.key, pair);
    const denied = { ...firstEcho };
    const remedy = { ...second };
    const body = {
      messages: [
        { role: "assistant", content: [denied] },
        { role: "assistant", content: [remedy] },
      ],
    };
    const echo = captureRewriteEcho({ family, body });
    const firstStamp = { v: 1, id: 1 };
    const secondStamp = { v: 1, id: 2 };
    Object.defineProperty(body.messages[0], rewriteOrigin, {
      value: firstStamp,
      enumerable: true,
    });
    Object.defineProperty(body.messages[1], rewriteOrigin, {
      value: secondStamp,
      enumerable: true,
    });
    const providerRequest = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_shared",
              name: denied.name,
              input: denied.input,
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_shared",
              name: remedy.name,
              input: remedy.input,
            },
          ],
        },
      ],
    };
    Object.defineProperty(providerRequest.messages[0], rewriteOrigin, {
      value: firstStamp,
      enumerable: true,
    });
    Object.defineProperty(providerRequest.messages[1], rewriteOrigin, {
      value: secondStamp,
      enumerable: true,
    });
    restoreRewriteCalls({
      family,
      clientRequest: echo.request,
      providerRequest,
      recorded: saved,
    });
    expect(providerRequest.messages[0].content[0].name).toBe(
      "archestra__run_tool",
    );
    expect(providerRequest.messages[1].content[0].name).toBe(
      "archestra__execute_remedy_plan",
    );
  });

  test("does not restore a stamped holder when the echo semantic core differs", () => {
    const family = "anthropic:messages";
    const original = {
      type: "tool_use",
      id: "toolu_provider",
      name: "read",
      input: { path: "a" },
    };
    const echoed = {
      type: "tool_use",
      id: "client_call",
      name: "read",
      input: { path: "a" },
    };
    const saved = records(
      recordRewriteCalls({
        family,
        response: { content: [echoed] },
        originals: captureRewriteCalls({
          family,
          response: { content: [original] },
        }),
        emitted: [{ id: original.id, wireId: "client_call" }],
        recorded: new Map(),
      }),
    );
    const holder = {
      type: "tool_use",
      id: "client_call",
      name: "read",
      input: { path: "changed" },
    };
    const body = { messages: [{ role: "assistant", content: [holder] }] };
    const echo = captureRewriteEcho({ family, body });
    Object.defineProperty(holder, rewriteOrigin, {
      value: { v: 1, id: 9 },
      enumerable: true,
    });
    const derived = { ...holder, id: "hitl_replaced" };
    const providerRequest = {
      messages: [{ role: "assistant", content: [derived] }],
    };
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: echo.request,
        providerRequest,
        recorded: saved,
        sources: echo.sources,
      }),
    ).toThrow("does not match");
    expect(derived.id).toBe("hitl_replaced");
    expect(derived.input).toEqual({ path: "changed" });
  });

  test("keeps text newlines, Unicode, and lone-surrogate escapes exactly", () => {
    const original = "\r\n\ntext\u00e9\ud800\n\n";
    const rewritten = `receipt\n\n${original}`;
    const pair = recordRewriteText({ original, rewritten });
    expect(pair).toBeDefined();
    const saved = records(pair ? [pair] : []);
    expect(restoreRewriteText({ text: rewritten, recorded: saved })).toBe(
      original,
    );
    expect(rewriteTextKey("\ud800")).not.toBe(rewriteTextKey("\ufffd"));
    expect(
      recordRewriteText({ original, rewritten: original }),
    ).toBeUndefined();
  });
});

function records(pairs: RewriteBytes[]): Map<string, RewriteBytes> {
  return new Map(pairs.map((pair) => [pair.key, pair]));
}
