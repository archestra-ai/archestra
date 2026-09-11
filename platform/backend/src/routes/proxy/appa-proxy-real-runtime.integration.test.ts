import db, { schema } from "@/database";
import { AppaApprovalModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  type AppaProxyHookConfig,
  AppaProxyHookSession,
  canonicalJsonObject,
} from "./appa-proxy-hook";

const runtimeUrl = process.env.APPA_TEST_RUNTIME_URL;
const runtimeToken = process.env.APPA_TEST_RUNTIME_TOKEN;
const approvalSigningSecret = process.env.APPA_TEST_APPROVAL_SECRET;
const runRealRuntime = Boolean(
  runtimeUrl && runtimeToken && approvalSigningSecret,
);

function config(): AppaProxyHookConfig {
  if (!runtimeUrl || !runtimeToken || !approvalSigningSecret) {
    throw new Error(
      "APPA real-runtime integration environment is not configured",
    );
  }
  return {
    url: runtimeUrl,
    timeoutMs: 10_000,
    sessionHmacSecret: "appa-test-session-hmac-secret-0123456789abcdef",
    runtimeToken,
    approvalSigningSecret,
    autoAcceptRestrictions: true,
  };
}

function outbound(
  id: string,
  targetName: string,
  targetArguments: Record<string, unknown> = {},
) {
  const emittedArguments = JSON.stringify(targetArguments);
  return {
    id,
    emittedName: targetName,
    emittedArguments,
    emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
    targetName,
    targetArguments,
  };
}

async function acquire(params: {
  profileId: string;
  organizationId?: string;
  clientSessionId: string;
  parentClientSessionId?: string;
  spawnBinding?: string;
  toolResults?: Parameters<
    typeof AppaProxyHookSession.acquire
  >[0]["toolResults"];
}) {
  return await AppaProxyHookSession.acquire({
    config: config(),
    profileId: params.profileId,
    organizationId: params.organizationId,
    ownerScopeHash: `real-runtime-owner:${params.profileId}`,
    clientSessionId: params.clientSessionId,
    parentClientSessionId: params.parentClientSessionId,
    spawnBinding: params.spawnBinding,
    toolResults: params.toolResults ?? [],
  });
}

describe.skipIf(!runRealRuntime)("OpenAPPA v1 real runtime integration", () => {
  test("admits parallel public reads and reversed inbound results through durable hook turns", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA real runtime parallel reads" });
    const clientSessionId = `parallel-${crypto.randomUUID()}`;
    const first = await acquire({ profileId: agent.id, clientSessionId });
    await first.sendPrompt({ messages: [{ role: "user", content: "status" }] });
    await first.authorizeOutboundToolCalls([
      outbound("public-first", "read_public_status"),
      outbound("public-second", "read_public_status"),
    ]);
    first.markOutboundCallsDelivered();
    await first.finish();

    const second = await acquire({
      profileId: agent.id,
      clientSessionId,
      toolResults: [
        { id: "public-second", content: { ordinal: 2 } },
        { id: "public-first", content: { ordinal: 1 } },
      ],
    });
    expect(second.getModelResultUpdates()).toEqual(
      new Map([
        ["public-second", '{"ordinal":2}'],
        ["public-first", '{"ordinal":1}'],
      ]),
    );
    await second.sendPrompt({
      messages: [{ role: "user", content: "continue" }],
    });
    await second.finish();
  });

  test("replays a singleton internal restriction and binds the configured sanitizer", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      name: "APPA real runtime singleton remedies",
    });
    const internal = await acquire({
      profileId: agent.id,
      clientSessionId: `internal-${crypto.randomUUID()}`,
    });
    await internal.sendPrompt({
      messages: [{ role: "user", content: "notify" }],
    });
    await internal.authorizeOutboundToolCalls([
      outbound("internal-send", "mcp__claude_ai_Slack__slack_send_message", {
        channel: "internal-test-channel",
        text: "synthetic status",
      }),
    ]);
    internal.markOutboundCallsDelivered();
    await internal.finish();

    const clientSessionId = `sanitize-${crypto.randomUUID()}`;
    const first = await acquire({ profileId: agent.id, clientSessionId });
    await first.sendPrompt({
      messages: [{ role: "user", content: "contact" }],
    });
    await first.authorizeOutboundToolCalls([
      outbound("sanitized-contact", "read_sanitized_contact", { q: "contact" }),
    ]);
    first.markOutboundCallsDelivered();
    await first.finish();

    const second = await acquire({
      profileId: agent.id,
      clientSessionId,
      toolResults: [
        { id: "sanitized-contact", content: "synthetic@example.test" },
      ],
    });
    const presentation = second
      .getModelResultUpdates()
      .get("sanitized-contact");
    expect(presentation).toContain("[redacted-email]");
    expect(presentation).not.toContain("synthetic@example.test");
    await second.sendPrompt({
      messages: [{ role: "user", content: "continue" }],
    });
    await second.finish();
  });

  test("submits a fixture-backed signed approval to the real runtime", async ({
    makeAdmin,
    makeAgent,
    makeMember,
  }) => {
    const agent = await makeAgent({ name: "APPA real runtime approval" });
    const reviewer = await makeAdmin();
    await makeMember(reviewer.id, agent.organizationId, { role: "admin" });
    const session = await acquire({
      profileId: agent.id,
      organizationId: agent.organizationId,
      clientSessionId: `approval-${crypto.randomUUID()}`,
    });
    await session.sendPrompt({
      messages: [{ role: "user", content: "restart" }],
    });
    const authorization = session.authorizeOutboundToolCalls([
      outbound("restart", "restart_deployment", { name: "synthetic" }),
    ]);
    await expect
      .poll(async () => {
        const [approval] = await db
          .select({ id: schema.appaApprovalsTable.id })
          .from(schema.appaApprovalsTable)
          .limit(1);
        return approval?.id;
      })
      .toBeTypeOf("string");
    const [approval] = await db
      .select()
      .from(schema.appaApprovalsTable)
      .limit(1);
    if (!approval) throw new Error("APPA approval was not created");
    expect(
      await AppaApprovalModel.decide({
        organizationId: agent.organizationId,
        id: approval.id,
        userId: reviewer.id,
        isAgentAdmin: true,
        approverId: reviewer.id,
        decision: "approve",
        audit: {
          actorName: reviewer.name,
          actorEmail: reviewer.email,
          actorType: "user",
          impersonatedBy: null,
          requestId: crypto.randomUUID(),
          httpPath: "/test/appa-approval",
        },
      }),
    ).toMatchObject({ status: "approved", approverId: reviewer.id });
    expect(
      await AppaApprovalModel.getForTurn({
        id: approval.id,
        sessionId: approval.sessionId,
        activeTurnId: approval.activeTurnId,
      }),
    ).toMatchObject({ status: "approved", approverId: reviewer.id });
    await authorization;
    session.markOutboundCallsDelivered();
    await session.finish();
  });

  test("starts and ends a declared child through the runtime-issued spawn binding", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      name: "APPA real runtime child lifecycle",
    });
    const parentClientSessionId = `parent-${crypto.randomUUID()}`;
    const parent = await acquire({
      profileId: agent.id,
      clientSessionId: parentClientSessionId,
    });
    await parent.sendPrompt({
      messages: [{ role: "user", content: "delegate" }],
    });
    await parent.authorizeOutboundToolCalls([
      {
        ...outbound("spawn-child", "kagent__NS__log_analyst"),
        spawn: true,
      },
    ]);
    const spawnBindings = parent.getSpawnBindingsHeaderValue();
    expect(spawnBindings).toBeTypeOf("string");
    const spawnBinding = JSON.parse(spawnBindings ?? "{}") as Record<
      string,
      string
    >;
    expect(spawnBinding["spawn-child"]).toBeTypeOf("string");
    parent.markOutboundCallsDelivered();
    await parent.finish();

    const child = await acquire({
      profileId: agent.id,
      clientSessionId: `child-${crypto.randomUUID()}`,
      parentClientSessionId,
      spawnBinding: spawnBinding["spawn-child"],
    });
    await child.sendPrompt({
      messages: [{ role: "user", content: "analyze" }],
    });
    await child.finish({ childReturn: "synthetic child result" });
  });
});
