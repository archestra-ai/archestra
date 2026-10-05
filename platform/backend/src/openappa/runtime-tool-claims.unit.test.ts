import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  captureRewriteCalls,
  type RewriteWireFamily,
  recordRewriteCalls,
  restoreRewriteCalls,
} from "./rewrite-echo";
import {
  assertRuntimeToolProofReplay,
  isIssuedRuntimeToolProof,
  RUNTIME_TOOL_PROOF_ARGUMENT,
  signRuntimeToolProof,
  verifyRuntimeToolProof,
} from "./runtime-tool-claims";

const session = {
  organization_id: "org",
  caller_id: "user:owner",
  session_id: "user:owner|workspace:child",
  parent_id: "user:owner|workspace",
};
const request = {
  session,
  toolCallId: "call-start",
  action: "start_run",
  arguments: {
    agent_id: "worker",
    prompt: "Prepare a report",
    attachments: [{ filename: "input.txt", text: "private input" }],
  },
  spawn: true,
  secret: "test-runtime-tool-signing-key",
};

function verify(
  overrides: Partial<Parameters<typeof verifyRuntimeToolProof>[0]> = {},
) {
  return verifyRuntimeToolProof({
    proof: signRuntimeToolProof(request),
    organizationId: session.organization_id,
    callerId: session.caller_id,
    action: request.action,
    arguments: request.arguments,
    secret: request.secret,
    ...overrides,
  });
}

describe("runtime tool origin proofs", () => {
  it("retains the native child source instead of the gateway's root", () => {
    expect(verify()).toEqual({
      session,
      toolCallId: "call-start",
      spawn: true,
    });
  });

  it("tolerates key ordering but binds all nested attachment bytes", () => {
    expect(
      verify({
        arguments: {
          attachments: [{ text: "private input", filename: "input.txt" }],
          prompt: "Prepare a report",
          agent_id: "worker",
        },
      }),
    ).not.toBeNull();
    expect(
      verify({
        arguments: {
          ...request.arguments,
          attachments: [{ filename: "input.txt", text: "substituted" }],
        },
      }),
    ).toBeNull();
  });

  it.each([
    { organizationId: "another-org" },
    { callerId: "user:another-owner" },
    { callerId: undefined },
    { action: "write_workspace_file" },
    { secret: "another-key" },
    { arguments: { ...request.arguments, agent_id: "another-worker" } },
    { proof: "malformed" },
  ])("refuses a proof replayed with different authority or data: %j", (change) => {
    expect(verify(change)).toBeNull();
  });

  it("cannot authorize modified arguments beyond a log truncation boundary", () => {
    const prefix = "x".repeat(200_000);
    const args = { prompt: `${prefix}A` };
    const proof = signRuntimeToolProof({ ...request, arguments: args });
    expect(verify({ proof, arguments: args })).not.toBeNull();
    expect(verify({ proof, arguments: { prompt: `${prefix}B` } })).toBeNull();
  });

  it("does not sign missing keys or recursively cyclic arguments", () => {
    expect(signRuntimeToolProof({ ...request, secret: "" })).toBeUndefined();
    const args: Record<string, unknown> = {};
    args.self = args;
    expect(
      signRuntimeToolProof({ ...request, arguments: args }),
    ).toBeUndefined();
  });

  it("refuses expired and future proofs even when authority and arguments match", () => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    expect(verify({ proof, now: 1_299 })).not.toBeNull();
    expect(verify({ proof, now: 1_300 })).toBeNull();
    expect(verify({ proof, now: 969 })).toBeNull();
  });

  it.each([
    { call_id: "another-call" },
    { session_id: "another-source" },
    { parent_id: "another-parent" },
    { spawn: false },
  ])("binds the signed call, source, parent, and spawn claims: %j", (change) => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    if (!proof) throw new Error("Missing fixture proof");
    const [payload, mac] = proof.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, ...change }),
    ).toString("base64url");
    expect(verify({ proof: `${tampered}.${mac}`, now: 1_001 })).toBeNull();
  });

  it("rejects a shared-reference graph without expanding it exponentially", () => {
    let shared: unknown = { value: "leaf" };
    for (let depth = 0; depth < 40; depth++)
      shared = { left: shared, right: shared };
    expect(
      signRuntimeToolProof({ ...request, arguments: { graph: shared } }),
    ).toBeUndefined();
    expect(
      signRuntimeToolProof({
        ...request,
        arguments: { left: { value: "leaf" }, right: { value: "leaf" } },
      }),
    ).toBeDefined();
  });
});

describe("runtime proof issuer recognition is not authorization", () => {
  it("recognizes an expired issued credential without granting live execution", () => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    expect(isIssuedRuntimeToolProof({ proof, secret: request.secret })).toBe(
      true,
    );
    expect(verify({ proof, now: 1_300 })).toBeNull();
  });

  it("recognizes foreign organization and caller credentials to prevent leaks", () => {
    const proof = signRuntimeToolProof({
      ...request,
      session: {
        ...session,
        organization_id: "foreign-org",
        caller_id: "user:foreign-owner",
      },
      now: 1_000,
    });
    expect(isIssuedRuntimeToolProof({ proof, secret: request.secret })).toBe(
      true,
    );
    expect(verify({ proof, now: 1_001 })).toBeNull();
  });

  it("does not turn unknown signed actions, future dates, or changed arguments into grants", () => {
    for (const change of [
      { action: "unknown_runtime_action", now: 1_000 },
      { now: 5_000 },
    ]) {
      const proof = signRuntimeToolProof({ ...request, ...change });
      expect(isIssuedRuntimeToolProof({ proof, secret: request.secret })).toBe(
        true,
      );
      expect(verify({ proof, now: 1_001 })).toBeNull();
    }
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    expect(isIssuedRuntimeToolProof({ proof, secret: request.secret })).toBe(
      true,
    );
    expect(
      verify({ proof, now: 1_001, arguments: { prompt: "changed" } }),
    ).toBeNull();
  });

  it("rejects payload or MAC tampering and documents unavailable-key limits", () => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    if (!proof) throw new Error("Missing fixture proof");
    const [payload, mac] = proof.split(".");
    const tamperedPayload = Buffer.from('{"v":1}').toString("base64url");
    const tamperedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    const foreignDomainMac = createHmac("sha256", request.secret)
      .update(`another.issuer.v1.${payload}`)
      .digest("base64url");
    for (const value of [
      `${tamperedPayload}.${mac}`,
      `${payload}.${tamperedMac}`,
      `${payload}.${foreignDomainMac}`,
    ]) {
      expect(
        isIssuedRuntimeToolProof({ proof: value, secret: request.secret }),
      ).toBe(false);
    }
    expect(isIssuedRuntimeToolProof({ proof, secret: "rotated-key" })).toBe(
      false,
    );
    expect(isIssuedRuntimeToolProof({ proof, secret: "" })).toBe(false);
  });

  it.each(
    [
      undefined,
      null,
      false,
      1,
      [],
      { runtime_proof: "ordinary data" },
      "ordinary data",
      "not.a.runtime.proof",
      "a".repeat(16_385),
    ].map((proof) => ({ proof })),
  )("rejects ordinary, scalar, malformed, or oversized input", ({ proof }) => {
    expect(isIssuedRuntimeToolProof({ proof, secret: request.secret })).toBe(
      false,
    );
  });

  it("validates version and bounded claim shapes even with an authentic MAC", () => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    if (!proof) throw new Error("Missing fixture proof");
    const claims = JSON.parse(
      Buffer.from(proof.split(".")[0], "base64url").toString("utf8"),
    );
    for (const value of [
      { ...claims, v: 2 },
      { ...claims, organization_id: "" },
      { ...claims, caller_id: {} },
      { ...claims, session_id: "x".repeat(2_049) },
      { ...claims, extra: "unexpected" },
      null,
      "ordinary scalar",
    ]) {
      const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
      const mac = createHmac("sha256", request.secret)
        .update(`archestra.appa.runtime-tool.v1.${payload}`)
        .digest("base64url");
      expect(
        isIssuedRuntimeToolProof({
          proof: `${payload}.${mac}`,
          secret: request.secret,
        }),
      ).toBe(false);
    }
  });

  it("does not search or mutate data, schema, quoted proof strings, or wrapper objects", () => {
    const proof = signRuntimeToolProof({ ...request, now: 1_000 });
    const data = {
      runtime_proof: "ordinary data",
      schema: { properties: { runtime_proof: { const: proof } } },
      quote: JSON.stringify({ runtime_proof: proof }),
      tool_args: { runtime_proof: proof },
    };
    const before = JSON.stringify(data);
    for (const value of [data, data.schema, data.quote, data.tool_args]) {
      expect(
        isIssuedRuntimeToolProof({ proof: value, secret: request.secret }),
      ).toBe(false);
    }
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("runtime proof provider boundary", () => {
  it("still identifies an issued credential when both alias and inverse are missing", () => {
    const fixture = replayFixture("openai:responses", "string");
    const before = JSON.stringify(fixture.providerRequest);
    restoreRewriteCalls({ ...fixture, recorded: new Map() });
    expect(
      isIssuedRuntimeToolProof({
        proof: fixture.targetProof(),
        secret: request.secret,
      }),
    ).toBe(true);
    expect(() =>
      assertRuntimeToolProofReplay({
        role: "assistant",
        original: undefined,
        restored: Buffer.from(JSON.stringify(fixture.target)),
      }),
    ).toThrow("does not match retained provider bytes");
    expect(JSON.stringify(fixture.providerRequest)).toBe(before);
  });

  it.each<RewriteWireFamily>([
    "anthropic:messages",
    "openai:chatCompletions",
    "openai:responses",
  ])("restores whole retained %s calls, not proof-only inverses", (family) => {
    for (const wrapping of ["direct", "object", "string"] as const) {
      const fixture = replayFixture(family, wrapping);
      expect(
        verify({ proof: fixture.proof, arguments: fixture.args, now: 1_001 }),
      ).not.toBeNull();
      expect(
        verify({ proof: fixture.proof, arguments: fixture.args, now: 1_300 }),
      ).toBeNull();
      expect(
        isIssuedRuntimeToolProof({
          proof: fixture.targetProof(),
          secret: request.secret,
        }),
      ).toBe(true);

      // Historical replay needs only retained bytes, not a fresh signing key.
      restoreRewriteCalls(fixture);
      const restored = Buffer.from(JSON.stringify(fixture.target));
      expect(restored.equals(fixture.original)).toBe(true);
      expect(
        isIssuedRuntimeToolProof({
          proof: fixture.targetProof(),
          secret: request.secret,
        }),
      ).toBe(false);
      expect(() =>
        assertRuntimeToolProofReplay({
          role: "assistant",
          original: fixture.original,
          restored,
        }),
      ).not.toThrow();
      const input = fixture.target.input as Record<string, unknown> | undefined;
      if (input) {
        const args = wrapping === "direct" ? input : input.tool_args;
        if (typeof args === "object" && args !== null) {
          expect(Object.hasOwn(args, "__proto__")).toBe(true);
          expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
        }
      }
    }
  });

  it.each([
    "proof",
    "arguments",
    "action",
    "call",
  ])("does not strip a tampered %s into an acceptable retained call", (change) => {
    const fixture = replayFixture("openai:responses", "string");
    const call = fixture.clientRequest.input[0];
    if (change === "action") call.name = "archestra__get_run";
    else if (change === "call") call.type = "custom_tool_call";
    else {
      const wrapper = JSON.parse(call.arguments as string);
      const args = JSON.parse(wrapper.tool_args);
      if (change === "proof") args.runtime_proof = "malformed";
      else args.prompt = "changed";
      wrapper.tool_args = JSON.stringify(args);
      call.arguments = JSON.stringify(wrapper);
    }
    const before = JSON.stringify(fixture.providerRequest);
    expect(() => restoreRewriteCalls(fixture)).toThrow();
    expect(JSON.stringify(fixture.providerRequest)).toBe(before);
  });

  it("rejects missing inverses, wrong roles, and lossy proof-only cleanup", () => {
    const original = Buffer.from('{ "arguments": "literal private bytes" }');
    for (const role of ["user", "tool", "system"]) {
      expect(() =>
        assertRuntimeToolProofReplay({ role, original, restored: original }),
      ).toThrow("does not match retained provider bytes");
    }
    for (const retained of [undefined, original]) {
      expect(() =>
        assertRuntimeToolProofReplay({
          role: "assistant",
          original: retained,
          restored: Buffer.from('{"arguments":"literal private bytes"}'),
        }),
      ).toThrow("does not match retained provider bytes");
    }
  });

  it("leaves unsigned ordinary proof keys, schemas, results, and text verbatim", () => {
    const ordinary = JSON.parse(
      '{ "runtime_proof": "ordinary", "__proto__": {"keep":true}, "nested": {"runtime_proof":"data"} }',
    );
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "ordinary-call",
          name: "archestra__start_run",
          arguments:
            '{ "runtime_proof": "not a host proof", "prompt": "text" }',
        },
        {
          type: "function_call",
          call_id: "ordinary-object-wrapper",
          name: "archestra__run_tool",
          arguments:
            '{ "tool_name": "archestra__start_run", "tool_args": {"runtime_proof":"ordinary argument"} }',
        },
        {
          type: "function_call",
          call_id: "ordinary-string-wrapper",
          name: "archestra__run_tool",
          arguments:
            '{ "tool_name": "archestra__start_run", "tool_args": "{ \\"runtime_proof\\": \\"ordinary argument\\" }" }',
        },
        {
          type: "function_call_output",
          call_id: "ordinary-call",
          output: ordinary,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(ordinary) },
            { type: "input_text", text: signRuntimeToolProof(request) },
          ],
        },
      ],
      tools: [{ name: "example", parameters: { properties: ordinary } }],
      metadata: ordinary,
    };
    const before = JSON.stringify(body);
    restoreRewriteCalls({
      family: "openai:responses",
      clientRequest: structuredClone(body),
      providerRequest: body,
      recorded: new Map(),
    });
    expect(JSON.stringify(body)).toBe(before);
    expect(Object.hasOwn(body.metadata, "__proto__")).toBe(true);
  });
});

function replayFixture(
  family: RewriteWireFamily,
  wrapping: "direct" | "object" | "string",
) {
  const literal =
    '{ "prompt": "\\u0061", "n": 1e0, "__proto__": {"kept":true}, "schema": {"properties": {"runtime_proof": {"type":"string"}}}, "nested": {"runtime_proof":"ordinary data"} }';
  const args = JSON.parse(literal) as Record<string, unknown>;
  const proof = signRuntimeToolProof({
    ...request,
    arguments: args,
    now: 1_000,
  });
  const signed = { ...args, [RUNTIME_TOOL_PROOF_ARGUMENT]: proof };
  const originalArgs =
    wrapping === "direct"
      ? literal
      : `{ "tool_name": "archestra__start_run", "runtime_proof": "ordinary wrapper data", "tool_args": ${wrapping === "string" ? JSON.stringify(literal) : literal} }`;
  const clientArgs =
    wrapping === "direct"
      ? signed
      : {
          ...JSON.parse(originalArgs),
          tool_args: wrapping === "string" ? JSON.stringify(signed) : signed,
        };
  const name =
    wrapping === "direct" ? "archestra__start_run" : "archestra__run_tool";
  const call = (argumentsText: string): Record<string, unknown> =>
    family === "anthropic:messages"
      ? {
          type: "tool_use",
          id: request.toolCallId,
          name,
          input: JSON.parse(argumentsText),
        }
      : family === "openai:chatCompletions"
        ? {
            type: "function",
            id: request.toolCallId,
            function: { name, arguments: argumentsText },
          }
        : {
            type: "function_call",
            call_id: request.toolCallId,
            name,
            arguments: argumentsText,
            namespace: "runtime",
          };
  const response = (node: Record<string, unknown>) =>
    family === "anthropic:messages"
      ? { content: [node] }
      : family === "openai:chatCompletions"
        ? { choices: [{ message: { role: "assistant", tool_calls: [node] } }] }
        : { output: [node] };
  const history = (node: Record<string, unknown>) => ({
    ...(family === "anthropic:messages"
      ? { messages: [{ role: "assistant", content: [node] }] }
      : family === "openai:chatCompletions"
        ? { messages: [{ role: "assistant", tool_calls: [node] }] }
        : {}),
    input: family === "openai:responses" ? [node] : [],
  });
  const originals = captureRewriteCalls({
    family,
    response: response(call(originalArgs)),
  });
  const clientCall = call(JSON.stringify(clientArgs));
  const pairs = recordRewriteCalls({
    family,
    originals,
    response: response(clientCall),
    emitted: [{ id: request.toolCallId }],
    recorded: new Map(),
  });
  const target = structuredClone(clientCall);
  const original = originals.get(request.toolCallId);
  if (!original) throw new Error("Missing fixture provider call");
  const targetProof = () => {
    const rawArgs =
      family === "anthropic:messages"
        ? target.input
        : family === "openai:chatCompletions"
          ? (target.function as Record<string, unknown>).arguments
          : target.arguments;
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    const rawTarget = wrapping === "direct" ? args : args.tool_args;
    const targetArgs =
      typeof rawTarget === "string" ? JSON.parse(rawTarget) : rawTarget;
    return targetArgs[RUNTIME_TOOL_PROOF_ARGUMENT];
  };
  return {
    family,
    proof,
    args,
    original,
    target,
    targetProof,
    clientRequest: history(structuredClone(clientCall)),
    providerRequest: history(target),
    recorded: new Map(pairs.map((pair) => [pair.key, pair])),
  };
}
