import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { openappaActor } from "@/openappa/actor";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  clearHitlReview,
  consumeHitlRuling,
  peekHitlRuling,
  recordHitlRuling,
  stageHitlReview,
} from "./hitl-review";
import {
  awaitRuntimeHitlReview,
  bindRuntimeHitlReview,
  decideRuntimeHitlReview,
  readRuntimeHitlReview,
} from "./runtime-hitl-review";
import type { OpenAppaSession } from "./service";

setupTestCacheManager();

test("an unattended review waits for an authenticated ruling without consuming it", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "waited");
  const controller = new AbortController();
  try {
    const pending = awaitRuntimeHitlReview({
      session: fixture.session,
      offerId: "waited",
      userId: fixture.actorUserId ?? undefined,
      signal: controller.signal,
    });
    expect(
      await peekHitlRuling({ session: fixture.session, offerId: "waited" }),
    ).toBeUndefined();
    expect(
      await decideRuntimeHitlReview({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        offerId: "waited",
        reviewerUserId: fixture.actorUserId ?? "",
        decision: "approve",
      }),
    ).toEqual({ status: "recorded" });
    await expect(pending).resolves.toBe("approve");
    expect(
      await consumeHitlRuling({ session: fixture.session, offerId: "waited" }),
    ).toBe("approve");
    expect(
      await consumeHitlRuling({ session: fixture.session, offerId: "waited" }),
    ).toBeUndefined();
  } finally {
    controller.abort();
  }
});

test("parallel reviews remain queued when the first offer is answered", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "first");
  await stageAndBind(fixture, "second");
  expect(await readRuntimeHitlReview(fixture)).toMatchObject({
    offerId: "first",
  });
  expect(
    await decideRuntimeHitlReview({
      ...fixture,
      offerId: "first",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "deny",
    }),
  ).toEqual({ status: "recorded" });
  expect(await readRuntimeHitlReview(fixture)).toMatchObject({
    offerId: "second",
  });
  expect(
    await decideRuntimeHitlReview({
      ...fixture,
      offerId: "first",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "missing" });
  expect(await readRuntimeHitlReview(fixture)).toMatchObject({
    offerId: "second",
  });
});

test("concurrent owner decisions spend one staged review only", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "concurrent");
  const decide = (decision: "approve" | "deny") =>
    decideRuntimeHitlReview({
      ...fixture,
      offerId: "concurrent",
      reviewerUserId: fixture.actorUserId ?? "",
      decision,
    });
  const results = await Promise.all([decide("approve"), decide("deny")]);
  expect(results.filter((result) => result.status === "recorded")).toHaveLength(
    1,
  );
  const ruling = await consumeHitlRuling({
    session: fixture.session,
    offerId: "concurrent",
  });
  expect(["approve", "deny"]).toContain(ruling);
  expect(
    await consumeHitlRuling({
      session: fixture.session,
      offerId: "concurrent",
    }),
  ).toBeUndefined();
});

test("disconnecting a runtime waiter does not dismiss or approve the review", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "disconnected");
  const controller = new AbortController();
  controller.abort();
  await expect(
    awaitRuntimeHitlReview({
      session: fixture.session,
      offerId: "disconnected",
      userId: fixture.actorUserId ?? undefined,
      signal: controller.signal,
    }),
  ).resolves.toBe("unavailable");
  expect(await readRuntimeHitlReview(fixture)).toMatchObject({
    offerId: "disconnected",
  });
  expect(
    await consumeHitlRuling({
      session: fixture.session,
      offerId: "disconnected",
    }),
  ).toBeUndefined();
});

test("binds a user-owned offer and does not treat the index as approval", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "offer-1");

  expect(
    await readRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
    }),
  ).toMatchObject({
    offerId: "offer-1",
    reviewerUserId: fixture.actorUserId,
    text: "Review this call.",
  });
  expect(
    await consumeHitlRuling({ session: fixture.session, offerId: "offer-1" }),
  ).toBeUndefined();
});

test("rejects a session suffix that names another actor's workspace", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const victim = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  const attacker = await makeUser();
  await stageHitlReview({
    session: {
      organization_id: victim.organizationId,
      caller_id: `user:${attacker.id}`,
      session_id: `user:${attacker.id}|${victim.workloadName}`,
    },
    review: { offerId: "stolen", text: "Review this call." },
  });
  await bindRuntimeHitlReview({
    session: {
      organization_id: victim.organizationId,
      caller_id: `user:${attacker.id}`,
      session_id: `user:${attacker.id}|${victim.workloadName}`,
    },
    review: { offerId: "stolen", text: "Review this call." },
  });

  expect(
    await readRuntimeHitlReview({
      organizationId: victim.organizationId,
      workspaceId: victim.workspaceId,
    }),
  ).toBeUndefined();
});

test("binds a child offer to the workspace without moving the ruling onto the root", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  const child: OpenAppaSession = {
    ...fixture.session,
    session_id: `${fixture.session.session_id}:native-child`,
    parent_id: fixture.session.session_id,
  };
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(child.session_id),
    root: openappaActor(fixture.session.session_id),
    organizationId: fixture.organizationId,
    callerId: child.caller_id,
    sessionId: child.session_id,
    parentId: child.parent_id,
    startDecision: { decision: "ack", protocol: 1 },
  });
  await stageHitlReview({
    session: child,
    review: { offerId: "child-offer", text: "Review the child call." },
  });
  await bindRuntimeHitlReview({
    session: child,
    review: { offerId: "child-offer", text: "Review the child call." },
  });

  expect(
    await decideRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      offerId: "child-offer",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "recorded" });
  expect(
    await consumeHitlRuling({ session: child, offerId: "child-offer" }),
  ).toBe("approve");
  expect(
    await consumeHitlRuling({
      session: fixture.session,
      offerId: "child-offer",
    }),
  ).toBeUndefined();
});

test("a team runtime stays blocked and a denial cannot be overwritten by a later approval", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "team",
  });
  await stageAndBind(fixture, "offer-1");
  expect(fixture.actorUserId).toBeNull();
  expect(
    await decideRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      offerId: "offer-1",
      reviewerUserId: "not-a-reviewer",
      decision: "approve",
    }),
  ).toEqual({ status: "no_reviewer" });
  expect(
    await consumeHitlRuling({ session: fixture.session, offerId: "offer-1" }),
  ).toBeUndefined();

  const owned = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(owned, "offer-deny");
  await recordHitlRuling({
    session: owned.session,
    offerId: "offer-deny",
    ruling: "deny",
  });
  expect(
    await decideRuntimeHitlReview({
      organizationId: owned.organizationId,
      workspaceId: owned.workspaceId,
      offerId: "offer-deny",
      reviewerUserId: owned.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "conflict" });
  expect(
    await consumeHitlRuling({
      session: owned.session,
      offerId: "offer-deny",
    }),
  ).toBe("deny");

  const later = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(later, "offer-form");
  expect(
    await decideRuntimeHitlReview({
      organizationId: later.organizationId,
      workspaceId: later.workspaceId,
      offerId: "offer-form",
      reviewerUserId: later.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "recorded" });
  await recordHitlRuling({
    session: later.session,
    offerId: "offer-form",
    ruling: "deny",
  });
  expect(
    await consumeHitlRuling({
      session: later.session,
      offerId: "offer-form",
    }),
  ).toBe("deny");
});

test("an invalidated offer and a second decision cannot spend the first ruling twice", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const fixture = await createRuntime({
    makeOrganization,
    makeUser,
    makeAgent,
    actorKind: "user",
  });
  await stageAndBind(fixture, "offer-1");
  await stageAndBind(fixture, "offer-2");
  await clearHitlReview({ session: fixture.session, offerId: "offer-1" });
  expect(
    await decideRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      offerId: "offer-1",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "conflict" });
  expect(
    await decideRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      offerId: "offer-2",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "approve",
    }),
  ).toEqual({ status: "recorded" });
  expect(
    await decideRuntimeHitlReview({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      offerId: "offer-2",
      reviewerUserId: fixture.actorUserId ?? "",
      decision: "deny",
    }),
  ).toEqual({ status: "missing" });
  expect(
    await consumeHitlRuling({ session: fixture.session, offerId: "offer-2" }),
  ).toBe("approve");
  expect(
    await consumeHitlRuling({ session: fixture.session, offerId: "offer-2" }),
  ).toBeUndefined();
});

async function stageAndBind(
  fixture: Awaited<ReturnType<typeof createRuntime>>,
  offerId: string,
) {
  await stageHitlReview({
    session: fixture.session,
    review: {
      offerId,
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: '{"value":1}',
    },
  });
  await bindRuntimeHitlReview({
    session: fixture.session,
    review: {
      offerId,
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: '{"value":1}',
    },
  });
}

async function createRuntime(params: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeAgent: (input: { organizationId: string }) => Promise<{ id: string }>;
  actorKind: "user" | "team";
}) {
  const organization = await params.makeOrganization();
  const user = await params.makeUser();
  const agent = await params.makeAgent({ organizationId: organization.id });
  const actorId = params.actorKind === "user" ? user.id : `team-${user.id}`;
  const context = await A2AContextModel.create({
    actorKind: params.actorKind,
    actorId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const workloadName = `runtime-review-${task.id}`;
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: params.actorKind,
    actorId,
    actorUserId: params.actorKind === "user" ? user.id : null,
    workloadName,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  const workspace = await AgentWorkspaceModel.create({
    organizationId: organization.id,
    agentId: agent.id,
    actorKind: params.actorKind,
    actorId,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const sessionCaller =
    params.actorKind === "user"
      ? `user:${user.id}`
      : `agent-workspace:${workspace.id}`;
  const session: OpenAppaSession = {
    organization_id: organization.id,
    caller_id: sessionCaller,
    session_id: `${sessionCaller}|${workloadName}`,
  };
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(session.session_id),
    root: openappaActor(session.session_id),
    organizationId: organization.id,
    callerId: sessionCaller,
    sessionId: session.session_id,
    parentId: null,
    startDecision: { decision: "ack" },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    workloadName,
    actorUserId: run.actorUserId,
    session,
  };
}
