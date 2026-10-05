import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  captureRewriteRequest,
  RewriteProjectionError,
  rewriteOrigin,
  rewritePolicyEpoch,
  rewriteSpliceKey,
} from "./rewrite-projection";
import { stampToolCallId } from "./trajectory-stamp";

type RewriteCapture = ReturnType<typeof captureRewriteRequest>;
type ProjectOptions = NonNullable<Parameters<RewriteCapture["project"]>[2]>;
type RewriteProjection = ReturnType<RewriteCapture["project"]>;
type RewriteFragmentPair =
  Parameters<RewriteCapture["project"]>[1] extends ReadonlyMap<
    string,
    infer Pair
  >
    ? Pair
    : never;
type RewriteWireFamily = Parameters<typeof captureRewriteRequest>[1];

const anthropic = "anthropic:messages" as const;
const chat = "openai:chatCompletions" as const;
const responses = "openai:responses" as const;

describe("rewrite projection", () => {
  test("preserves empty Responses tool declarations across appended turns", () => {
    const input = [
      { type: "additional_tools", id: "tools-1", role: "developer", tools: [] },
      { type: "message", role: "user", content: [] },
    ];
    const body = { model: "test-model", input: structuredClone(input) };
    const first = captureRewriteRequest(body, responses).project(
      body,
      new Map(),
      { allowInitial: true },
    );
    expect(first.request).toEqual(body);
    const next = {
      model: "test-model",
      input: [...structuredClone(input), { role: "user", content: "next" }],
    };
    const second = captureRewriteRequest(next, responses).project(
      next,
      pairs(first),
      { heads: first.heads },
    );
    expect(second.request).toEqual(next);
  });

  test("replays recorded bytes when the renderer changes", () => {
    const body = {
      model: "m",
      max_tokens: 8,
      system: "Base",
      messages: [{ role: "user", content: "hello" }],
    };
    const capture = captureRewriteRequest(body, anthropic);
    body.system = "Base\nGUIDANCE-V1";
    body.messages[0].content = "hello [v1]";
    body.messages.push({ role: "user", content: "ANCHOR-V1" });
    const first = capture.project(body, new Map(), { allowInitial: true });

    const next = {
      model: "m",
      max_tokens: 99,
      tool_choice: "auto",
      system: "Base",
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: "next" },
      ],
    };
    const again = captureRewriteRequest(next, anthropic);
    next.system = "Base\nGUIDANCE-V2";
    next.messages[0].content = "hello [v2]";
    next.messages.splice(1, 0, { role: "user", content: "ANCHOR-V2" });
    const second = again.project(next, pairs(first), {
      heads: first.heads,
    });

    expect(second.request).toMatchObject({
      system: "Base\nGUIDANCE-V1",
      max_tokens: 99,
      tool_choice: "auto",
      messages: [
        { role: "user", content: "hello [v1]" },
        { role: "user", content: "ANCHOR-V1" },
        { role: "user", content: "next" },
      ],
    });
    expect(JSON.stringify(second.request)).not.toContain("GUIDANCE-V2");
    expect(JSON.stringify(second.request)).not.toContain("hello [v2]");
    expect(second.records.map((record) => record.key)).not.toEqual(
      expect.arrayContaining(first.records.map((record) => record.key)),
    );
    expect(
      prefixKeys(first, "item").some((key) => secondKeys(second).has(key)),
    ).toBe(false);
  });

  test.each([
    [anthropic, "system", undefined],
    [anthropic, "system", ""],
    [anthropic, "system", []],
    [responses, "instructions", undefined],
    [responses, "instructions", ""],
    [responses, "instructions", []],
  ] as const)("anchors injected guidance in an empty source envelope (%s, %s, %j)", (family, field, value) => {
    const source = (appended = false): Record<string, unknown> => ({
      model: "m",
      ...(value === undefined ? {} : { [field]: structuredClone(value) }),
      [family === responses ? "input" : "messages"]: [
        { role: "user", content: "Read the synthetic record." },
        ...(appended ? [{ role: "user", content: "Repeat the answer." }] : []),
      ],
    });
    const guidance = (version: string) =>
      Array.isArray(value) ? [{ type: "text", text: version }] : version;
    const body = source();
    const capture = captureRewriteRequest(body, family);
    body[field] = guidance("GUIDANCE-V1");
    const first = capture.project(body, new Map(), { allowInitial: true });
    expect(first.request).toEqual(body);

    const appended = source(true);
    const again = captureRewriteRequest(appended, family);
    appended[field] = guidance("GUIDANCE-V2");
    const second = again.project(appended, pairs(first), {
      heads: first.heads,
    });
    expect(second.request).toEqual({
      ...source(true),
      [field]: guidance("GUIDANCE-V1"),
    });
    expect(second.records).toHaveLength(1);

    const withoutGuidance = source(true);
    const third = captureRewriteRequest(withoutGuidance, family).project(
      withoutGuidance,
      pairs(first, second),
      { heads: second.heads },
    );
    expect(third.request).toEqual(second.request);
    expect(third.records).toHaveLength(0);

    const missing = pairs(first);
    const envelope = first.records.find((record) =>
      record.key.includes(":envelope:"),
    );
    if (!envelope) throw new Error("missing envelope anchor");
    missing.delete(envelope.key);
    expectReject(
      () => replay(source(true), family, missing, { heads: first.heads }),
      "unrecorded",
    );
    expectReject(
      () => captureRewriteRequest({ ...source(), [field]: null }, family),
      "incompatible",
    );
  });

  test.each([
    [anthropic, "system", undefined],
    [anthropic, "system", []],
    [responses, "instructions", undefined],
    [responses, "instructions", ""],
  ] as const)("keeps an untouched empty envelope unchanged (%s, %s, %j)", (family, field, value) => {
    const body = {
      model: "m",
      ...(value === undefined ? {} : { [field]: value }),
      [family === responses ? "input" : "messages"]: [
        { role: "user", content: "Read the synthetic record." },
      ],
    };
    const first = replay(body, family, new Map(), { allowInitial: true });
    expect(first.request).toEqual(body);
    const repeated = replay(structuredClone(body), family, pairs(first), {
      heads: first.heads,
    });
    expect(repeated.request).toEqual(body);
    expect(repeated.records).toHaveLength(0);
  });

  test("appended turn keeps the injected guidance anchor and only stores the suffix", () => {
    const body = {
      model: "m",
      max_tokens: 4,
      messages: [{ role: "user", content: "hello" }],
    };
    const capture = captureRewriteRequest(body, chat);
    body.messages.unshift({ role: "developer", content: "CONSTANT" });
    const first = capture.project(body, new Map(), { allowInitial: true });
    const next = {
      model: "m2",
      max_tokens: 40,
      tool_choice: "required",
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: "tail" },
      ],
    };
    const again = captureRewriteRequest(next, chat);
    next.messages.unshift({ role: "developer", content: "CONSTANT-MOVED" });
    next.messages.splice(2, 0, { role: "developer", content: "DRIFT" });
    const second = again.project(next, pairs(first), { heads: first.heads });
    expect(second.request).toMatchObject({
      model: "m2",
      max_tokens: 40,
      tool_choice: "required",
      messages: [
        { role: "developer", content: "CONSTANT" },
        { role: "user", content: "hello" },
        { role: "user", content: "tail" },
      ],
    });
    expect(JSON.stringify(second.request)).not.toContain("DRIFT");
    expect(JSON.stringify(second.request)).not.toContain("CONSTANT-MOVED");
    expect(second.records).toHaveLength(1);
  });

  test("cache markers move without rewriting content or stacking breakpoints", () => {
    const schema = {
      type: "object",
      properties: { cache_control: { type: "string" } },
      "x-keep": true,
    };
    const source = () => ({
      model: "m",
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "a", input_schema: schema, unknown_tool: "yes" },
        {
          name: "b",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    });
    const firstBody = source();
    const first = captureRewriteRequest(firstBody, anthropic).project(
      firstBody,
      new Map(),
      { allowInitial: true },
    );
    const moved = source();
    moved.tools[0].cache_control = { type: "ephemeral", ttl: "5m" };
    delete moved.tools[1].cache_control;
    const secondCapture = captureRewriteRequest(moved, anthropic);
    const second = secondCapture.project(moved, pairs(first), {
      heads: first.heads,
    });
    const tools = (second.request as { tools: Array<Record<string, unknown>> })
      .tools;
    expect(tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(tools[1].cache_control).toBeUndefined();
    expect(tools[0].input_schema).toEqual(schema);
    expect(tools[0].unknown_tool).toBe("yes");
    expect(markerCount(second.request)).toBe(1);
    expect(
      second.records.every((record) => record.key.includes(":cache:")),
    ).toBe(true);

    const pinned = source();
    const pinnedCapture = captureRewriteRequest(pinned, anthropic);
    delete pinned.tools[1].cache_control;
    pinned.tools[0].cache_control = { type: "ephemeral", ttl: "1h" };
    const third = pinnedCapture.project(pinned, pairs(first), {
      heads: first.heads,
    });
    const pinnedTools = (
      third.request as { tools: Array<Record<string, unknown>> }
    ).tools;
    expect(pinnedTools[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(pinnedTools[0].cache_control).toBeUndefined();
    expect(
      third.records.filter((record) => record.key.includes(":cache:")),
    ).toHaveLength(0);
  });

  test("an allowed policy splice cannot replay the old secret", () => {
    const secret = "SECRET-VALUE";
    const body = {
      model: "m",
      max_tokens: 4,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "read",
              input: { cache_control: "user-field", path: "a" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: secret,
              vendor: "keep",
            },
          ],
        },
      ],
    };
    const first = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      {
        allowInitial: true,
      },
    );
    expect(JSON.stringify(first.request)).toContain(secret);
    for (const record of first.records) {
      expect(record.original.toString("utf8")).not.toContain(secret);
      expect(record.rewritten.toString("utf8")).not.toContain(secret);
    }
    const frozen = first.records.map((record) => ({
      key: record.key,
      original: Buffer.from(record.original),
      rewritten: Buffer.from(record.rewritten),
    }));

    const echo = structuredClone(body);
    const updates = new Map<string, unknown>([["t1", "APPROVED"]]);
    const again = captureRewriteRequest(echo, anthropic);
    expect(again.candidateKeys(echo, { toolResultUpdates: updates })).toContain(
      rewriteSpliceKey(anthropic, "t1", "APPROVED"),
    );
    const second = again.project(echo, pairs(first), {
      heads: first.heads,
      toolResultUpdates: updates,
    });
    expect(JSON.stringify(second.request)).toContain("APPROVED");
    expect(JSON.stringify(second.request)).not.toContain(secret);
    expect(JSON.stringify(second.request)).toContain("user-field");
    expect(JSON.stringify(second.request)).toContain("keep");
    expect(second.records.map((record) => record.key)).toEqual(
      expect.arrayContaining([
        rewriteSpliceKey(anthropic, "t1", "APPROVED"),
        `anthropic:messages:splice-index:${second.heads.splice}`,
      ]),
    );
    expect(second.heads.splice).toEqual(expect.any(String));
    for (const record of frozen) {
      const current = first.records.find((item) => item.key === record.key);
      expect(current?.original.equals(record.original)).toBe(true);
      expect(current?.rewritten.equals(record.rewritten)).toBe(true);
    }

    const rollback = structuredClone(body);
    const result = rollback.messages[1].content[0] as { content: string };
    result.content = secret;
    const third = captureRewriteRequest(rollback, anthropic).project(
      rollback,
      pairs(first, second),
      { heads: second.heads, toolResultUpdates: updates },
    );
    expect(JSON.stringify(third.request)).not.toContain(secret);
    expect(JSON.stringify(third.request)).toContain("APPROVED");
    expect(third.records).toHaveLength(0);
  });

  test("bakes a first-sight policy output and does not index it", () => {
    const body = toolResult("SECRET-VALUE");
    const first = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      {
        allowInitial: true,
        policySplices: [
          { id: "alias-not-on-atom", content: "IGNORE" },
          { toolResultId: "t1", content: "APPROVED" },
        ],
      },
    );
    expect(JSON.stringify(first.request)).toContain("APPROVED");
    expect(JSON.stringify(first.request)).not.toContain("SECRET-VALUE");
    expect(first.heads.splice).toBeUndefined();
    expect(first.records.some((record) => record.key.includes(":splice"))).toBe(
      false,
    );
    const later = toolResult("SECRET-VALUE");
    const second = captureRewriteRequest(later, anthropic).project(
      later,
      pairs(first),
      { heads: first.heads },
    );
    expect(JSON.stringify(second.request)).toContain("APPROVED");
    expect(JSON.stringify(second.request)).not.toContain("SECRET-VALUE");
    expect(second.records).toHaveLength(0);
  });

  test("a resent result keeps the baked admission when policy repeats", () => {
    const firstBody = toolResult("RAW SECRET");
    const first = captureRewriteRequest(firstBody, anthropic).project(
      firstBody,
      new Map(),
      {
        allowInitial: true,
        policySplices: [{ toolResultId: "t1", content: "APPROVED" }],
      },
    );
    expect(JSON.stringify(first.request)).toContain("APPROVED");
    expect(first.heads.splice).toBeUndefined();
    const altered = toolResult("ALTERED RAW SECRET");
    const second = captureRewriteRequest(altered, anthropic).project(
      altered,
      pairs(first),
      {
        heads: first.heads,
        policySplices: [{ toolResultId: "t1", content: "APPROVED" }],
      },
    );
    expect(JSON.stringify(second.request)).toContain("APPROVED");
    expect(JSON.stringify(second.request)).not.toContain("ALTERED RAW SECRET");
    expect(JSON.stringify(second.request)).not.toContain("RAW SECRET");
    expect(second.records).toHaveLength(0);
  });

  test("a stamped result id does not hide an approved result change", () => {
    const stamp = stampToolCallId({
      callId: "t1",
      sessionId: "s",
      organizationId: "o",
      callerId: "c",
      secret: "k",
    });
    const source = toolResult("SECRET-VALUE");
    const result = source.messages[0].content[0];
    result.tool_use_id = stamp;
    const capture = captureRewriteRequest(source, anthropic);
    result.tool_use_id = "t1";
    result.content = "APPROVED";
    const first = capture.project(source, new Map(), {
      allowInitial: true,
      policySplices: [{ toolResultId: stamp, content: "APPROVED" }],
    });
    expect(JSON.stringify(first.request)).toContain("APPROVED");
    expect(JSON.stringify(first.request)).not.toContain("SECRET-VALUE");

    const resent = toolResult("ALTERED RAW SECRET");
    const resentResult = resent.messages[0].content[0];
    resentResult.tool_use_id = stamp;
    const again = captureRewriteRequest(resent, anthropic);
    resentResult.tool_use_id = "t1";
    resentResult.content = "APPROVED";
    const second = again.project(resent, pairs(first), {
      heads: first.heads,
      policySplices: [{ toolResultId: stamp, content: "APPROVED" }],
    });
    expect(JSON.stringify(second.request)).toContain("APPROVED");
    expect(JSON.stringify(second.request)).not.toContain("ALTERED RAW SECRET");
    expect(JSON.stringify(second.request)).not.toContain("SECRET-VALUE");
  });

  test("a later policy for the inner call id replaces the stamped admission", () => {
    const stamp = stampToolCallId({
      callId: "t1",
      sessionId: "s",
      organizationId: "o",
      callerId: "c",
      secret: "k",
    });
    const source = toolResult("SECRET-VALUE");
    source.messages[0].content[0].tool_use_id = stamp;
    const first = captureRewriteRequest(source, anthropic).project(
      source,
      new Map(),
      {
        allowInitial: true,
        policySplices: [{ toolResultId: "t1", content: "APPROVED" }],
      },
    );
    const resent = toolResult("ALTERED RAW SECRET");
    resent.messages[0].content[0].tool_use_id = stamp;
    const second = captureRewriteRequest(resent, anthropic).project(
      resent,
      pairs(first),
      {
        heads: first.heads,
        policySplices: [{ toolResultId: "t1", content: "launch a1" }],
      },
    );
    expect(JSON.stringify(second.request)).toContain("launch a1");
    expect(JSON.stringify(second.request)).not.toContain("APPROVED");
    expect(JSON.stringify(second.request)).not.toContain("ALTERED RAW SECRET");
  });

  test("keeps an override when a later turn omits the policy update", () => {
    const secret = "SECRET-VALUE";
    const approved = "APPROVED";
    const first = projectTool(secret);
    const override = projectTool(secret, pairs(first), {
      heads: first.heads,
      policySplices: [{ toolResultId: "t1", content: approved }],
    });
    expect(override.heads.splice).toEqual(expect.any(String));
    expect(rewritePolicyEpoch(approved)).toHaveLength(64);
    const omitted = projectTool(secret, pairs(first, override), {
      heads: override.heads,
    });
    expect(JSON.stringify(omitted.request)).toContain(approved);
    expect(JSON.stringify(omitted.request)).not.toContain(secret);
    expect(omitted.records).toHaveLength(0);

    const cancelled = projectTool(secret, pairs(first, override), {
      heads: override.heads,
      policySplices: [{ toolResultId: "t1", content: secret }],
    });
    expect(cancelled.heads.splice).not.toBe(override.heads.splice);
    const afterCancel = projectTool(secret, pairs(first, override, cancelled), {
      heads: cancelled.heads,
    });
    expect(JSON.stringify(afterCancel.request)).toContain(secret);
    expect(JSON.stringify(afterCancel.request)).not.toContain(approved);
  });

  test("loads a splice index in level batches and rejects a corrupt node", () => {
    const count = 9;
    const first = projectMany(count);
    const splices = Array.from({ length: count }, (_, index) => ({
      toolResultId: `id-${index}`,
      content: `approved-${index}`,
    }));
    const split = projectMany(count, pairs(first), {
      heads: first.heads,
      policySplices: splices,
    });
    expect(split.heads.splice).toEqual(expect.any(String));
    const capture = captureRewriteRequest(manyBody(count), anthropic);
    const empty = new Map<string, RewriteFragmentPair>();
    const rootBatch = capture.referencedSpliceKeys(empty, split.heads);
    expect(rootBatch).toEqual([
      `anthropic:messages:splice-index:${split.heads.splice}`,
    ]);
    const rootOnly = new Map<string, RewriteFragmentPair>();
    const root = split.records.find((record) => record.key === rootBatch[0]);
    if (!root) throw new Error("missing index root");
    rootOnly.set(root.key, root);
    const next = capture.referencedSpliceKeys(rootOnly, split.heads);
    expect(next.length).toBeGreaterThan(0);
    expect(next.length).toBeLessThan(count);
    expect(next.every((key) => key.includes(":splice-index:"))).toBe(true);
    const loaded = pairs(first, split);
    expect(capture.referencedSpliceKeys(loaded, split.heads)).toEqual([]);
    const one = projectMany(count, loaded, {
      heads: split.heads,
      policySplices: [{ toolResultId: "id-0", content: "approved-0-v2" }],
    });
    const previousIndex = split.records
      .filter((record) => record.key.includes(":splice-index:"))
      .map((record) => record.key);
    const rewritten = new Set(one.records.map((record) => record.key));
    expect(previousIndex.some((key) => !rewritten.has(key))).toBe(true);
    expect(
      one.records.filter((record) => record.key.includes(":splice-index:"))
        .length,
    ).toBeLessThan(count);
    const corrupt = new Map(loaded);
    const flipped = Buffer.from(root.rewritten);
    flipped[flipped.length - 1] ^= 0xff;
    corrupt.set(root.key, { original: root.original, rewritten: flipped });
    expect(() => capture.referencedSpliceKeys(corrupt, split.heads)).toThrow(
      RewriteProjectionError,
    );
    const changed = manyBody(count);
    changed.messages[0].content = "edited-history";
    expect(() =>
      captureRewriteRequest(changed, anthropic).project(changed, loaded, {
        heads: split.heads,
      }),
    ).toThrow(expect.objectContaining({ code: "unrecorded" }));
  });

  test.each([
    false,
    true,
  ])("replays and updates splice keys sharing multiple hash nibbles (nested=%s)", (nested) => {
    const shared: string[] = [];
    const outside: string[] = [];
    for (let index = 0; index < 65536 && shared.length < 10; index++) {
      const id = `call_shared_${index}`;
      const digest = createHash("sha256").update(id).digest("hex");
      if (digest.startsWith("00")) shared.push(id);
      else if (outside.length < 2) outside.push(id);
    }
    expect(shared).toHaveLength(10);
    const ids = [...(nested ? outside : []), ...shared];
    const source = () => ({
      model: "m",
      messages: ids.flatMap((id) => [
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "read", input: { id } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content: `raw-${id}` },
          ],
        },
      ]),
    });
    const first = replay(source(), anthropic, new Map(), {
      allowInitial: true,
    });
    const updates = ids.slice(0, -1).map((id) => ({
      toolResultId: id,
      content: `approved-${id}`,
    }));
    const split = replay(source(), anthropic, pairs(first), {
      heads: first.heads,
      policySplices: updates,
    });
    const stored = pairs(first, split);
    const echoed = source();
    const capture = captureRewriteRequest(echoed, anthropic);
    expect(capture.referencedSpliceKeys(stored, split.heads)).toEqual([]);
    const repeated = capture.project(echoed, stored, { heads: split.heads });
    expect(repeated.request).toEqual(split.request);
    expect(repeated.records).toHaveLength(0);

    const changed = [
      { toolResultId: shared[0], content: "revised-admission" },
      { toolResultId: shared[9], content: "new-admission" },
    ];
    const updated = replay(source(), anthropic, stored, {
      heads: split.heads,
      policySplices: changed,
    });
    const expected = source();
    const admitted = new Map(
      [...updates, ...changed].map((entry) => [
        entry.toolResultId,
        entry.content,
      ]),
    );
    for (const message of expected.messages) {
      for (const block of message.content) {
        if ("tool_use_id" in block && typeof block.tool_use_id === "string") {
          block.content = admitted.get(block.tool_use_id) ?? block.content;
        }
      }
    }
    expect(updated.request).toEqual(expected);
    const afterUpdate = replay(
      source(),
      anthropic,
      pairs(first, split, updated),
      { heads: updated.heads },
    );
    expect(afterUpdate.request).toEqual(expected);
    expect(afterUpdate.records).toHaveLength(0);

    const rootKey = `anthropic:messages:splice-index:${split.heads.splice}`;
    const root = stored.get(rootKey);
    if (!root) throw new Error("missing splice root");
    const missingChildren = pairs(first);
    missingChildren.set(rootKey, root);
    expect(
      capture.referencedSpliceKeys(missingChildren, split.heads).length,
    ).toBeGreaterThan(0);
    expectReject(
      () =>
        replay(source(), anthropic, missingChildren, { heads: split.heads }),
      "unrecorded",
    );
  });

  test("unknown or incompatible metadata fails closed without echoing content", () => {
    const body = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: "hello-secret" },
        { role: "user", content: "second" },
      ],
    };
    const first = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      {
        allowInitial: true,
      },
    );
    const corrupt = pairs(first);
    const key = first.records[0].key;
    corrupt.set(key, {
      original: Buffer.from("nope"),
      rewritten: Buffer.from("nope"),
    });
    expectReject(() =>
      captureRewriteRequest(
        {
          model: "m",
          max_tokens: 2,
          messages: [
            { role: "user", content: "hello-secret" },
            { role: "user", content: "second" },
          ],
        },
        anthropic,
      ).project(
        {
          model: "m",
          max_tokens: 2,
          messages: [
            { role: "user", content: "hello-secret" },
            { role: "user", content: "second" },
          ],
        },
        corrupt,
        { heads: first.heads },
      ),
    );

    const versioned = pairs(first);
    versioned.set(key, {
      original: Buffer.from([0x52, 0x50, 0x31, 99, 0x49]),
      rewritten: Buffer.from([0x52, 0x50, 0x31, 99, 0x49]),
    });
    expectReject(
      () =>
        replay(
          {
            model: "m",
            max_tokens: 2,
            messages: [
              { role: "user", content: "hello-secret" },
              { role: "user", content: "second" },
            ],
          },
          anthropic,
          versioned,
          { heads: first.heads },
        ),
      "incompatible",
    );

    const reordered = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: "hello-secret" },
        { role: "user", content: "second" },
      ],
    };
    const reorderCapture = captureRewriteRequest(reordered, anthropic);
    const [left, right] = reordered.messages;
    reordered.messages[0] = right;
    reordered.messages[1] = left;
    expectReject(
      () =>
        reorderCapture.project(reordered, pairs(first), { heads: first.heads }),
      "reordered",
    );

    const lost = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: "hello-secret" },
        { role: "user", content: "second" },
      ],
    };
    const lostCapture = captureRewriteRequest(lost, anthropic);
    lost.messages[0] = { role: "user", content: "hello-secret" };
    expectReject(
      () => lostCapture.project(lost, pairs(first), { heads: first.heads }),
      "lost-source",
    );

    const forged = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: "hello-secret" },
        { role: "user", content: "second" },
      ],
    };
    const forgedCapture = captureRewriteRequest(forged, anthropic);
    const extra = { role: "user", content: "x" };
    Object.defineProperty(extra, rewriteOrigin, {
      enumerable: true,
      value: { v: 1, id: 99999 },
    });
    forged.messages.push(extra);
    expectReject(
      () => forgedCapture.project(forged, pairs(first), { heads: first.heads }),
      "unknown-provenance",
    );

    const diverged = {
      model: "m",
      max_tokens: 2,
      messages: [
        { role: "user", content: "hello-secret-changed" },
        { role: "user", content: "second" },
      ],
    };
    expectReject(
      () => replay(diverged, anthropic, pairs(first), { heads: first.heads }),
      "unrecorded",
    );
  });

  test("retains unknown tool, schema, and signed-thinking fields", () => {
    const body = {
      model: "m",
      max_tokens: 8,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "secret-thought",
              signature: "sig",
              vendor_ext: "keep",
              z: "héllo",
              a: "ü",
            },
            { type: "text", text: "ok" },
          ],
        },
      ],
      tools: [
        {
          name: "read",
          description: "d",
          unknown_tool: "yes",
          input_schema: {
            type: "object",
            properties: { cache_control: { type: "string" } },
            "x-keep": true,
          },
        },
      ],
    };
    const first = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      {
        allowInitial: true,
      },
    );
    const next = structuredClone(body);
    const again = captureRewriteRequest(next, anthropic);
    const thinking = next.messages[0].content[0] as Record<string, unknown>;
    delete thinking.vendor_ext;
    delete thinking.z;
    delete thinking.a;
    delete (next.tools[0] as { unknown_tool?: string }).unknown_tool;
    delete (next.tools[0].input_schema as { "x-keep"?: boolean })["x-keep"];
    const second = again.project(next, pairs(first), { heads: first.heads });
    const replayed = second.request as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      tools: Array<Record<string, unknown>>;
    };
    expect(replayed.messages[0].content[0]).toMatchObject({
      type: "thinking",
      thinking: "secret-thought",
      signature: "sig",
      vendor_ext: "keep",
      z: "héllo",
      a: "ü",
    });
    expect(Object.keys(replayed.messages[0].content[0])).toEqual([
      "type",
      "thinking",
      "signature",
      "vendor_ext",
      "z",
      "a",
    ]);
    expect(replayed.tools[0].unknown_tool).toBe("yes");
    expect(replayed.tools[0].input_schema).toEqual(body.tools[0].input_schema);
    expect(second.records).toHaveLength(0);
  });

  test("retains JSON-owned prototype keys in arguments, schema, and result holders", () => {
    const source = () =>
      JSON.parse(
        '{"model":"m","__proto__":{"root":"retain"},"tools":[{"name":"read","__proto__":{"tool":"retain"},"input_schema":{"type":"object","properties":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}}],"messages":[{"role":"assistant","__proto__":{"message":"retain"},"content":[{"type":"tool_use","id":"call_1","name":"read","input":{"__proto__":{"nested":{"__proto__":{"value":"retain"}}},"constructor":{"prototype":"ordinary data"}}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"raw-result","__proto__":{"result":"retain"}}]}]}',
      ) as {
        model: string;
        messages: Array<{
          role: string;
          content: Array<Record<string, unknown>>;
        }>;
        tools: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
    const body = source();
    const encoded = JSON.stringify(body);
    const first = replay(body, anthropic, new Map(), { allowInitial: true });
    expect(JSON.stringify(first.request)).toBe(encoded);
    const projected = first.request as ReturnType<typeof source>;
    const input = projected.messages[0].content[0].input as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);

    const appended = source();
    appended.messages.push({
      role: "user",
      content: [{ type: "text", text: "Read another record." }],
    });
    const second = replay(appended, anthropic, pairs(first), {
      heads: first.heads,
    });
    expect(JSON.stringify(second.request)).toBe(JSON.stringify(appended));
    expect(second.records).toHaveLength(1);

    const resent = source();
    resent.messages[1].content[0].content = "resent-raw-result";
    const admitted = replay(resent, anthropic, pairs(first), {
      heads: first.heads,
      toolResultUpdates: new Map([["call_1", "approved-result"]]),
    });
    const expected = source();
    expected.messages[1].content[0].content = "approved-result";
    expect(JSON.stringify(admitted.request)).toBe(JSON.stringify(expected));

    const tampered = source();
    const tamperedInput = tampered.messages[0].content[0].input as Record<
      string,
      unknown
    >;
    const ownPrototypeData = tamperedInput.__proto__ as Record<string, unknown>;
    ownPrototypeData.nested = "changed";
    expectReject(
      () => replay(tampered, anthropic, pairs(first), { heads: first.heads }),
      "unrecorded",
    );
  });

  test("storage grows with the changed suffix, and identity nodes stay tiny", () => {
    const big = "x".repeat(4000);
    const body = {
      model: "m",
      max_tokens: 4,
      messages: [
        { role: "user", content: big },
        { role: "user", content: `${big}y` },
        { role: "user", content: `${big}z` },
      ],
    };
    const first = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      {
        allowInitial: true,
      },
    );
    expect(first.records.length).toBeGreaterThan(0);
    for (const record of first.records) {
      expect(record.original.byteLength).toBeLessThan(48);
      expect(record.rewritten.byteLength).toBeLessThan(16);
      expect(record.rewritten.toString("utf8")).not.toContain("xxxx");
    }
    const next = {
      model: "m",
      max_tokens: 4,
      messages: [
        { role: "user", content: big },
        { role: "user", content: `${big}y` },
        { role: "user", content: `${big}z` },
        { role: "user", content: "tail" },
      ],
    };
    const again = captureRewriteRequest(next, anthropic);
    next.messages[3].content = "tail-rendered";
    const second = again.project(next, pairs(first), { heads: first.heads });
    expect(second.records).toHaveLength(1);
    const added = byteSize(second.records);
    expect(added).toBeLessThan(200);
    expect(byteSize(first.records) + added).toBeLessThan(400);
    expect(JSON.stringify(second.request)).toContain("tail-rendered");
    expect(JSON.stringify(second.request)).toContain(big);
  });

  test("stores each tool declaration as an identity fragment, not the schema array", () => {
    const huge = "s".repeat(3000);
    const body = {
      model: "m",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "srv",
          tools: [
            { name: "a", parameters: { type: "object", description: huge } },
            { name: "b", parameters: { type: "object", description: "small" } },
          ],
        },
      ],
    };
    const first = captureRewriteRequest(body, responses).project(
      body,
      new Map(),
      {
        allowInitial: true,
      },
    );
    const toolRecords = first.records.filter((record) =>
      record.key.includes(":tool:"),
    );
    expect(toolRecords).toHaveLength(3);
    for (const record of toolRecords) {
      expect(record.rewritten.byteLength).toBeLessThan(16);
      expect(record.rewritten.toString("utf8")).not.toContain(huge);
    }
    const next = structuredClone(body);
    const again = captureRewriteRequest(next, responses);
    delete (next.tools[0].tools[0].parameters as { description?: string })
      .description;
    const second = again.project(next, pairs(first), { heads: first.heads });
    const replayed = second.request as {
      tools: Array<{ tools: Array<{ parameters: { description?: string } }> }>;
    };
    expect(replayed.tools[0].tools[0].parameters.description).toBe(huge);
    expect(second.records).toHaveLength(0);
  });

  test("does not wrap a responses string input or share capture state", () => {
    const body = { model: "m", input: "héllo", instructions: "stay" };
    const capture = captureRewriteRequest(body, responses);
    expect(body.input).toBe("héllo");
    expect(typeof body.input).toBe("string");
    body.instructions = "stay\nCONSTANT";
    const first = capture.project(body, new Map(), { allowInitial: true });
    const next = {
      model: "m",
      input: "héllo",
      instructions: "stay",
      temperature: 0.2,
    };
    const again = captureRewriteRequest(next, responses);
    next.input = [
      { type: "message", role: "user", content: "other" },
    ] as unknown as string;
    next.instructions = "stay\nOTHER";
    const second = again.project(next, pairs(first), { heads: first.heads });
    expect(second.request).toMatchObject({
      input: "héllo",
      instructions: "stay\nCONSTANT",
      temperature: 0.2,
    });

    const left = captureRewriteRequest(
      { messages: [{ role: "user", content: "a" }] },
      chat,
    );
    const right = captureRewriteRequest(
      { messages: [{ role: "user", content: "b" }] },
      chat,
    );
    expect(left.keys).not.toEqual(right.keys);
  });

  test("text and compaction holders keep a comparable origin across spread", () => {
    const body = {
      model: "m",
      max_tokens: 4,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    const capture = captureRewriteRequest(body, anthropic);
    const block = body.messages[0].content[0];
    const copied = { ...block };
    expect(originOf(copied)).toBe(originOf(block));
    expect(JSON.stringify(block)).toBe('{"type":"text","text":"hello"}');
    body.messages[0] = {
      ...body.messages[0],
      content: body.messages[0].content.map((entry) => ({ ...entry })),
    };
    expect(() =>
      capture.project(body, new Map(), { allowInitial: true }),
    ).not.toThrow();

    const compacted = {
      model: "m",
      input: [{ type: "compaction", encrypted_content: "cipher" }],
    };
    captureRewriteRequest(compacted, responses);
    const item = compacted.input[0];
    expect(originOf({ ...item })).toBe(originOf(item));
    expect(JSON.stringify(item)).not.toContain("rewriteOrigin");
  });

  test("accepts tools listed before messages", () => {
    const body = {
      model: "m",
      max_tokens: 4,
      tools: [{ name: "read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const projected = captureRewriteRequest(body, anthropic).project(
      body,
      new Map(),
      { allowInitial: true },
    );
    expect(projected.request).toMatchObject({
      tools: [{ name: "read" }],
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("spread retains the origin symbol and the provider request does not", () => {
    const body = {
      model: "m",
      max_tokens: 2,
      messages: [{ role: "user", content: "hi" }],
    };
    captureRewriteRequest(body, anthropic);
    const copy = { ...body.messages[0] };
    expect(Object.getOwnPropertySymbols(copy)).toContain(rewriteOrigin);
    expect(JSON.stringify(body.messages[0])).toBe(
      '{"role":"user","content":"hi"}',
    );
    const providerBody = {
      model: "m",
      max_tokens: 2,
      messages: [{ role: "user", content: "hi" }],
    };
    const projected = captureRewriteRequest(providerBody, anthropic).project(
      providerBody,
      new Map(),
      { allowInitial: true },
    );
    expect(hasSymbol(projected.request)).toBe(false);
    expect(hasSymbol(providerBody)).toBe(false);
  });
});

function toolResult(content: string) {
  return {
    model: "m",
    max_tokens: 4,
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content, vendor: "keep" },
        ],
      },
    ],
  };
}

function projectTool(
  content: string,
  records: ReadonlyMap<string, RewriteFragmentPair> = new Map(),
  options: ProjectOptions = { allowInitial: true },
) {
  const body = toolResult(content);
  return captureRewriteRequest(body, anthropic).project(body, records, options);
}

type HistoryContent =
  | string
  | Array<{
      type: string;
      tool_use_id: string;
      content: string;
    }>;

function manyBody(count: number): {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: HistoryContent }>;
} {
  return {
    model: "m",
    max_tokens: 4,
    messages: Array.from({ length: count }, (_, index) => ({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `id-${index}`,
          content: `secret-${index}`,
        },
      ],
    })),
  };
}

function projectMany(
  count: number,
  records: ReadonlyMap<string, RewriteFragmentPair> = new Map(),
  options: ProjectOptions = { allowInitial: true },
) {
  const body = manyBody(count);
  return captureRewriteRequest(body, anthropic).project(body, records, options);
}

function pairs(
  ...projections: RewriteProjection[]
): Map<string, RewriteFragmentPair> {
  const map = new Map<string, RewriteFragmentPair>();
  for (const projection of projections) {
    for (const record of projection.records) {
      map.set(record.key, record);
    }
  }
  return map;
}

function replay(
  body: unknown,
  family: RewriteWireFamily,
  records: ReadonlyMap<string, RewriteFragmentPair>,
  options: ProjectOptions,
): RewriteProjection {
  return captureRewriteRequest(body, family).project(body, records, options);
}

function expectReject(
  run: () => unknown,
  code?: RewriteProjectionError["code"],
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RewriteProjectionError);
    expect((error as RewriteProjectionError).message).toBe(
      "rewrite projection rejected",
    );
    expect((error as RewriteProjectionError).message).not.toContain("secret");
    expect((error as RewriteProjectionError).message).not.toContain("hello");
    if (code) expect((error as RewriteProjectionError).code).toBe(code);
    return;
  }
  throw new Error("expected projection to fail");
}

function prefixKeys(projection: RewriteProjection, domain: string): string[] {
  return projection.records
    .map((record) => record.key)
    .filter((key) => key.includes(`:${domain}:`));
}

function secondKeys(projection: RewriteProjection): Set<string> {
  return new Set(projection.records.map((record) => record.key));
}

function markerCount(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((sum, entry) => sum + markerCount(entry), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  let count =
    record.cache_control && typeof record.cache_control === "object" ? 1 : 0;
  for (const key of Object.keys(record)) {
    if (key === "input" || key === "input_schema" || key === "arguments")
      continue;
    count += markerCount(record[key]);
  }
  return count;
}

function byteSize(records: readonly RewriteFragmentPair[]): number {
  return records.reduce(
    (sum, record) =>
      sum + record.original.byteLength + record.rewritten.byteLength,
    0,
  );
}

function originOf(value: object): unknown {
  return Object.getOwnPropertyDescriptor(value, rewriteOrigin)?.value;
}

function hasSymbol(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return true;
  for (const key of Object.keys(value as object)) {
    if (hasSymbol((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}
