import { describe, expect, test } from "vitest";
import {
  captureRewriteCalls,
  captureRewriteEcho,
  type RewriteBytes,
  type RewriteWireFamily,
  recordedDelegationText,
  recordRewriteCalls,
  recordRewriteText,
  restoreRewriteCalls,
  restoreRewriteText,
  rewriteEchoKeys,
  rewriteTextKey,
} from "./rewrite-echo";
import { rewriteOrigin } from "./rewrite-projection";
import { signRuntimeToolProof } from "./runtime-tool-claims";
import { stampToolCallId } from "./trajectory-stamp";

describe("exact APPA echo replay", () => {
  test("matches delegation insertion to one exact original string", () => {
    const marker =
      "\n\n[appa] delegated trajectory opaque-token \u2014 child of root.";
    const pair = {
      key: "test",
      original: Buffer.from(
        JSON.stringify({ prompt: "task", other: "task-long" }),
      ),
      rewritten: Buffer.from(JSON.stringify({ prompt: `task${marker}` })),
    };
    expect(recordedDelegationText(pair)).toEqual([
      { original: "task", rewritten: `task${marker}`, marker },
    ]);
    expect(
      recordedDelegationText({
        ...pair,
        original: Buffer.from(
          JSON.stringify({ prompt: "task", duplicate: "task" }),
        ),
      }),
    ).toEqual([]);
  });

  test("does not treat existing delegation text as a new inserted suffix", () => {
    const original = "quoted [appa] delegated trajectory old-token";
    expect(
      recordedDelegationText({
        key: "test",
        original: Buffer.from(JSON.stringify({ prompt: original })),
        rewritten: Buffer.from(
          JSON.stringify({
            prompt: `${original}\n\n[appa] delegated trajectory new-token`,
          }),
        ),
      }),
    ).toEqual([]);
  });

  test.each([
    false,
    true,
  ])("restores a call batch without changing caller order (reverse=%s)", (reverse) => {
    const family = "openai:responses";
    const originals = Array.from({ length: 32 }, (_, index) => ({
      type: "function_call",
      call_id: `provider-${index}`,
      name: "read",
      arguments: `{ "n":${index}, "path":"\\u0061" }`,
      provider_extension: index,
    }));
    const rewritten = originals.map((call, index) => ({
      ...call,
      call_id: `client-${index}`,
      arguments: JSON.stringify({ n: index, path: "a" }),
    }));
    const saved = records(
      recordRewriteCalls({
        family,
        response: { output: rewritten },
        originals: captureRewriteCalls({
          family,
          response: { output: originals },
        }),
        emitted: originals.map((call, index) => ({
          id: call.call_id,
          wireId: rewritten[index].call_id,
        })),
        recorded: new Map(),
      }),
    );
    const ordered = reverse ? [...rewritten].reverse() : rewritten;
    const spoof = { ...rewritten[0], role: "user" };
    const provider = { input: [...structuredClone(ordered), spoof] };
    restoreRewriteCalls({
      family,
      clientRequest: { input: structuredClone(rewritten) },
      providerRequest: provider,
      recorded: saved,
    });
    expect(JSON.stringify(provider.input)).toBe(
      JSON.stringify([
        ...(reverse ? [...originals].reverse() : originals),
        spoof,
      ]),
    );
    expect(spoof).toEqual({ ...rewritten[0], role: "user" });
  });

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
          response: {
            choices: [
              { message: { role: "assistant", tool_calls: [original] } },
            ],
          },
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

describe.each<RewriteWireFamily>([
  "anthropic:messages",
  "openai:chatCompletions",
  "openai:responses",
])("assistant call boundaries on %s", (family) => {
  test.each([
    false,
    true,
  ])("rejects duplicate candidate IDs without provenance (same-holder=%s)", (sameHolder) => {
    const fixture = roleBoundaryFixture(family);
    const first = fixture.history("assistant");
    const second = sameHolder ? first : fixture.history("assistant");
    const providerRequest = {
      input: [...(first.input ?? []), ...(second.input ?? [])],
      messages: [...(first.messages ?? []), ...(second.messages ?? [])],
    };
    const before = JSON.stringify(providerRequest);
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: fixture.history("assistant"),
        providerRequest,
        recorded: fixture.saved,
      }),
    ).toThrow("missing or ambiguous");
    expect(JSON.stringify(providerRequest)).toBe(before);
  });

  test.each([
    false,
    true,
  ])("keeps ID then identity then stamp matching priority (unique-id=%s)", (uniqueId) => {
    const fixture = roleBoundaryFixture(family);
    const holder = structuredClone(fixture.clientCall);
    const echo = captureRewriteEcho({
      family,
      body: fixture.history("assistant", holder),
    });
    const stamp = { v: 1, id: 1 };
    Object.defineProperty(holder, rewriteOrigin, {
      value: stamp,
      enumerable: true,
    });
    const identityTarget = { ...holder };
    identityTarget[family === "openai:responses" ? "call_id" : "id"] =
      "identity-target";
    Object.defineProperty(identityTarget, rewriteOrigin, {
      value: { v: 1, id: 2 },
      enumerable: true,
    });
    const stampTarget = structuredClone(fixture.clientCall);
    stampTarget[family === "openai:responses" ? "call_id" : "id"] =
      "stamp-target";
    Object.defineProperty(stampTarget, rewriteOrigin, {
      value: stamp,
      enumerable: true,
    });
    const idTarget = structuredClone(fixture.clientCall);
    const calls = [
      idTarget,
      ...(!uniqueId ? [structuredClone(fixture.clientCall)] : []),
      identityTarget,
      stampTarget,
    ];
    const histories = calls.map((call) => fixture.history("assistant", call));
    const providerRequest = {
      input: histories.flatMap((history) => history.input ?? []),
      messages: histories.flatMap((history) => history.messages ?? []),
    };
    const chosen = uniqueId ? idTarget : identityTarget;
    const untouched = calls
      .filter((call) => call !== chosen)
      .map((call) => JSON.stringify(call));
    restoreRewriteCalls({
      family,
      clientRequest: echo.request,
      sources: echo.sources,
      providerRequest,
      recorded: fixture.saved,
    });
    expect(JSON.stringify(chosen)).toBe(fixture.original.toString("utf8"));
    expect(
      calls
        .filter((call) => call !== chosen)
        .map((call) => JSON.stringify(call)),
    ).toEqual(untouched);
  });

  test("rejects competing unique client and original ID candidates", () => {
    const fixture = roleBoundaryFixture(family);
    const originalIdTarget = structuredClone(fixture.clientCall);
    originalIdTarget[family === "openai:responses" ? "call_id" : "id"] =
      "provider_call";
    const histories = [
      fixture.history("assistant"),
      fixture.history("assistant", originalIdTarget),
    ];
    const providerRequest = {
      input: histories.flatMap((history) => history.input ?? []),
      messages: histories.flatMap((history) => history.messages ?? []),
    };
    const before = JSON.stringify(providerRequest);
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: fixture.history("assistant"),
        providerRequest,
        recorded: fixture.saved,
      }),
    ).toThrow("missing or ambiguous");
    expect(JSON.stringify(providerRequest)).toBe(before);
  });

  test("deduplicates a site's own and parent stamp while rejecting duplicate identities", () => {
    const fixture = roleBoundaryFixture(family);
    const holder = structuredClone(fixture.clientCall);
    const echo = captureRewriteEcho({
      family,
      body: fixture.history("assistant", holder),
    });
    const stamp = { v: 1, id: 1 };
    Object.defineProperty(holder, rewriteOrigin, {
      value: stamp,
      enumerable: true,
    });
    const targets = [{ ...holder }, { ...holder }];
    for (const target of targets) {
      target[family === "openai:responses" ? "call_id" : "id"] = "changed";
    }
    const ambiguous = targets.map((target) =>
      fixture.history("assistant", target),
    );
    const providerRequest = {
      input: ambiguous.flatMap((history) => history.input ?? []),
      messages: ambiguous.flatMap((history) => history.messages ?? []),
    };
    expect(() =>
      restoreRewriteCalls({
        family,
        clientRequest: echo.request,
        sources: echo.sources,
        providerRequest,
        recorded: fixture.saved,
      }),
    ).toThrow("missing or ambiguous");

    const target = structuredClone(fixture.clientCall);
    target[family === "openai:responses" ? "call_id" : "id"] = "stamp-only";
    Object.defineProperty(target, rewriteOrigin, {
      value: stamp,
      enumerable: true,
    });
    const stamped = fixture.history("assistant", target);
    Object.defineProperty(
      family === "openai:responses"
        ? stamped
        : (stamped.messages?.[0] as object),
      rewriteOrigin,
      { value: stamp, enumerable: true },
    );
    // The ambiguous identity holders must not also match the source stamp.
    for (const candidate of targets)
      delete (candidate as Record<symbol, unknown>)[rewriteOrigin];
    // Responses calls share the request parent, so a stamped root owns all of them.
    const stampedProvider =
      family === "openai:responses"
        ? stamped
        : {
            messages: [
              ...providerRequest.messages,
              ...(stamped.messages ?? []),
            ],
          };
    restoreRewriteCalls({
      family,
      clientRequest: echo.request,
      sources: echo.sources,
      providerRequest: stampedProvider,
      recorded: fixture.saved,
    });
    expect(JSON.stringify(target)).toBe(fixture.original.toString("utf8"));
    expect(
      targets.map(
        (candidate) =>
          candidate[family === "openai:responses" ? "call_id" : "id"],
      ),
    ).toEqual(["changed", "changed"]);
  });

  test("restores owned nested argument string bytes and preserves cache/provenance", () => {
    const fixture = roleBoundaryFixture(family);
    const target = structuredClone(fixture.clientCall);
    const cacheControl = { type: "ephemeral", ttl: "5m" };
    const origin = { v: 1, id: 1 };
    target.cache_control = cacheControl;
    Object.defineProperty(target, rewriteOrigin, {
      value: origin,
      enumerable: true,
    });
    const providerRequest = fixture.history("assistant", target);
    const spoof = fixture.history("user");
    const spoofBefore = JSON.stringify(spoof);
    providerRequest.input?.push(...(spoof.input ?? []));
    providerRequest.messages?.push(...(spoof.messages ?? []));
    const references = restoreRewriteCalls({
      family,
      clientRequest: fixture.history("assistant"),
      providerRequest,
      recorded: fixture.saved,
    });
    const { cache_control, ...restored } = target;
    expect(JSON.stringify(restored)).toBe(fixture.original.toString("utf8"));
    expect(cache_control).toBe(cacheControl);
    expect((target as Record<symbol, unknown>)[rewriteOrigin]).toBe(origin);
    expect(references.get("client_call")).toBe("provider_call");
    expect(JSON.stringify(spoof)).toBe(spoofBefore);
  });

  test("wrong roles cannot supply or receive an assistant-owned inverse", () => {
    const fixture = roleBoundaryFixture(family);
    const roles =
      family === "openai:responses"
        ? ["user", "tool", "system"]
        : ["user", "tool", "system", undefined];
    for (const role of roles) {
      const spoof = fixture.history(role);
      const before = JSON.stringify(spoof);
      const echo = captureRewriteEcho({ family, body: spoof });
      expect(echo.hasCalls).toBe(false);
      expect(echo.sources).toHaveLength(0);
      expect(rewriteEchoKeys({ family, request: spoof })).toEqual([]);
      if (role !== undefined) {
        const response =
          family === "anthropic:messages"
            ? { role, content: [fixture.clientCall] }
            : family === "openai:chatCompletions"
              ? {
                  choices: [
                    { message: { role, tool_calls: [fixture.clientCall] } },
                  ],
                }
              : { output: [{ ...fixture.clientCall, role }] };
        expect(captureRewriteCalls({ family, response }).size).toBe(0);
      }
      expect(
        restoreRewriteCalls({
          family,
          clientRequest: spoof,
          providerRequest: spoof,
          recorded: fixture.saved,
        }).size,
      ).toBe(0);
      expect(JSON.stringify(spoof)).toBe(before);

      const owned = captureRewriteEcho({
        family,
        body: fixture.history("assistant"),
      });
      expect(() =>
        restoreRewriteCalls({
          family,
          clientRequest: owned.request,
          sources: owned.sources,
          providerRequest: spoof,
          recorded: fixture.saved,
        }),
      ).toThrow("missing or ambiguous");
      expect(JSON.stringify(spoof)).toBe(before);
    }
  });

  test("proof-shaped user data, schema, and result contents stay verbatim", () => {
    const fixture = roleBoundaryFixture(family);
    const quoted = structuredClone(fixture.clientCall);
    const data = {
      runtime_proof: "ordinary data",
      input: [quoted],
      output: [quoted],
      content: [quoted],
      tool_calls: [quoted],
      function_call: quoted,
    };
    const body = {
      ...fixture.history("user"),
      input:
        family === "openai:responses"
          ? [
              { role: "user", content: [quoted] },
              {
                type: "function_call_output",
                call_id: "client_call",
                output: data,
              },
            ]
          : [],
      // Request fields resembling response containers are not response spans.
      output: [quoted],
      content: [quoted],
      choices: [{ message: { role: "assistant", tool_calls: [quoted] } }],
      tools: [{ parameters: { properties: data } }],
      metadata: data,
    };
    if (family !== "openai:responses") {
      body.messages?.push(
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "client_call",
              content: data,
            },
            { type: "text", text: JSON.stringify(quoted) },
          ],
        },
        { role: "tool", tool_call_id: "client_call", content: data },
      );
    }
    const before = JSON.stringify(body);
    expect(captureRewriteEcho({ family, body }).hasCalls).toBe(false);
    restoreRewriteCalls({
      family,
      clientRequest: body,
      providerRequest: body,
      recorded: fixture.saved,
    });
    expect(JSON.stringify(body)).toBe(before);
  });
});

function roleBoundaryFixture(family: RewriteWireFamily) {
  const literal =
    '{ "prompt": "\\u0061", "n":1e0, "__proto__":{"kept":true}, "data":{"runtime_proof":"ordinary"} }';
  const args = JSON.parse(literal) as Record<string, unknown>;
  const proof = signRuntimeToolProof({
    session: { organization_id: "org", session_id: "source" },
    toolCallId: "provider_call",
    action: "start_run",
    arguments: args,
    spawn: true,
    secret: "synthetic-role-boundary-key",
    now: 1_000,
  });
  if (!proof) throw new Error("Missing fixture runtime proof");
  const originalArgs = `{ "tool_name": "archestra__start_run", "tool_args": ${JSON.stringify(literal)}, "runtime_proof":"ordinary wrapper data" }`;
  const signedArgs = JSON.stringify({
    ...JSON.parse(originalArgs),
    tool_args: JSON.stringify({ ...args, runtime_proof: proof }),
  });
  const call = (id: string, argumentsText: string): Record<string, unknown> =>
    family === "anthropic:messages"
      ? {
          type: "tool_use",
          id,
          name: "archestra__run_tool",
          input: JSON.parse(argumentsText),
        }
      : family === "openai:chatCompletions"
        ? {
            type: "function",
            id,
            function: {
              name: "archestra__run_tool",
              arguments: argumentsText,
            },
          }
        : {
            type: "function_call",
            call_id: id,
            name: "archestra__run_tool",
            arguments: argumentsText,
          };
  const originalCall = call("provider_call", originalArgs);
  const clientCall = call("client_call", signedArgs);
  const response = (node: Record<string, unknown>) =>
    family === "anthropic:messages"
      ? { content: [node] }
      : family === "openai:chatCompletions"
        ? { choices: [{ message: { role: "assistant", tool_calls: [node] } }] }
        : { output: [node] };
  const originals = captureRewriteCalls({
    family,
    response: response(originalCall),
  });
  const original = originals.get("provider_call");
  if (!original) throw new Error("Missing fixture provider call");
  const saved = records(
    recordRewriteCalls({
      family,
      response: response(clientCall),
      originals,
      emitted: [{ id: "provider_call", wireId: "client_call" }],
      recorded: new Map(),
    }),
  );
  const history = (
    role: string | undefined,
    node = structuredClone(clientCall),
  ): {
    input?: unknown[];
    messages?: Record<string, unknown>[];
  } =>
    family === "openai:responses"
      ? { input: [role === "assistant" ? node : { ...node, role }] }
      : {
          messages: [
            family === "anthropic:messages"
              ? { role, content: [node] }
              : { role, tool_calls: [node] },
          ],
        };
  return { clientCall, original, saved, history };
}

function records(pairs: RewriteBytes[]): Map<string, RewriteBytes> {
  return new Map(pairs.map((pair) => [pair.key, pair]));
}
