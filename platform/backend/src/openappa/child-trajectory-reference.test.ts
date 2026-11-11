import config from "@/config";
import db, { schema } from "@/database";
import {
  LlmProxyPluginRegistry,
  type LlmProxyToolCallsContext,
} from "@/proxy/plugins/registry";
import { expect, test } from "@/test";
import { openappaActor } from "./actor";
import {
  mintChildTrajectoryReceipt,
  verifyChildTrajectoryReceipt,
} from "./child-trajectory-receipt";
import {
  resolveChildTrajectoryReferences,
  retainChildTrajectoryReference,
} from "./child-trajectory-reference";
import { stripChildTrajectoryReferences } from "./child-trajectory-reference-format";
import { mintDelegationMarker } from "./delegation";
import { stripChildTrajectoryReceiptsFromRequest } from "./wire";

test("short child references survive replay and native resume without granting identity from the display code", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const previousSecret = config.openappa.offerSigningSecret;
  config.openappa.offerSigningSecret =
    "synthetic-reference-test-signing-secret";
  try {
    const session = {
      organization_id: organizationId,
      caller_id: "user:alice",
      session_id: "user:alice|parent:child",
      parent_id: "user:alice|parent",
    };
    await db.insert(schema.openappaSessionsTable).values({
      organizationId,
      callerId: session.caller_id,
      sessionId: session.parent_id,
      actor: openappaActor(session.parent_id),
      root: "synthetic-root",
      startDecision: { decision: "ack" },
    });
    const binding = {
      organizationId,
      callerId: session.caller_id,
      parentId: "parent",
      childId: "parent:child",
      childNativeId: "child",
      spawnerNativeId: "parent",
      spawnCallId: "spawn",
    };
    const full = mintChildTrajectoryReceipt(binding);
    if (!full) throw new Error("Missing signed fixture");
    const short = await retainChildTrajectoryReference(session, full);
    expect(short.length).toBeLessThan(70);
    expect(short).not.toContain("appact2");
    expect(await retainChildTrajectoryReference(session, full)).toBe(short);
    const reference = stripChildTrajectoryReferences(short).references[0];
    const resolve = (callerId = session.caller_id, references = [reference]) =>
      resolveChildTrajectoryReferences({
        organizationId,
        callerId,
        references,
      });
    const [receipt] = await resolve();
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId,
        callerId: session.caller_id,
        spawnerNativeId: "parent",
        childNativeId: "child",
      }),
    ).toBe(true);
    expect(
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId,
        callerId: session.caller_id,
        spawnerNativeId: "parent",
        childNativeId: "other",
      }),
    ).toBe(false);
    await expect(resolve("user:other")).rejects.toThrow("could not resolve");
    await expect(
      resolve(session.caller_id, [
        reference.slice(0, -1) + (reference.endsWith("A") ? "B" : "A"),
      ]),
    ).rejects.toThrow("could not resolve");
    const continuation = `\n\n${mintDelegationMarker({
      ...binding,
      prompt: "Continue the task.",
    })}\n\n${short}`;
    const finalize = async (appended: string, callerId = session.caller_id) => {
      const registry = new LlmProxyPluginRegistry();
      registry.register({
        id: "synthetic-resume",
        finalizesToolCalls: true,
        async onToolCalls({ toolCalls }) {
          return {
            decision: "allow",
            toolCalls: toolCalls.map((call) => ({
              ...call,
              arguments: {
                resume_from: "child",
                prompt: `Continue the task.${appended}`,
              },
            })),
            annotated: [
              {
                id: "resume",
                name: "spawn_subagent",
                field: "prompt",
                appended,
                continuationCallerId: callerId,
              },
            ],
          };
        },
      });
      const context: LlmProxyToolCallsContext = {
        requestId: "synthetic-request",
        organizationId,
        profileId: "synthetic-profile",
        provider: "xai",
        interactionType: "openai:responses",
        model: "synthetic-model",
        streaming: false,
        headers: {},
        requestBody: {},
        resources: new Map(),
        toolCalls: [
          {
            id: "resume",
            name: "spawn_subagent",
            arguments: { resume_from: "child", prompt: "Continue the task." },
          },
        ],
      };
      await registry.onSessionInit(context);
      return registry.onToolCalls(context);
    };
    await expect(finalize(continuation)).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(finalize(continuation, "user:other")).rejects.toThrow(
      "rewrote a call",
    );
    for (const invalid of [
      `${continuation}\nUnchecked instruction`,
      `${continuation}\n\n${short}`,
      continuation.replace("appa2-", "appa2-forged"),
      continuation.replace(reference, `${reference.slice(0, -1)}!`),
    ])
      await expect(finalize(invalid)).rejects.toThrow();
    const resumed = mintChildTrajectoryReceipt({
      ...binding,
      childNativeId: "resumed-native",
    });
    const resumedShort = await retainChildTrajectoryReference(
      session,
      resumed ?? "",
    );
    expect(resumedShort).not.toBe(short);
    expect((await resolve())[0]).toEqual(receipt);
    const references: string[] = [];
    const body = {
      input: [
        { role: "assistant", content: short },
        {
          type: "function_call_output",
          call_id: "wait",
          output: `=== Output ===\n${resumedShort}\n\nVALUE`,
        },
        {
          role: "user",
          content: `<system-reminder>\nBackground subagent completed:\n${resumedShort}\n</system-reminder>`,
        },
      ],
    };
    stripChildTrajectoryReceiptsFromRequest({
      family: "openai:responses",
      body,
      references,
    });
    expect(references).toEqual([reference]);
    expect(JSON.stringify(body)).not.toContain(resumedShort);
    expect(body.input[1].output).toBe("=== Output ===\nVALUE");
  } finally {
    config.openappa.offerSigningSecret = previousSecret;
  }
});
