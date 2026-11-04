import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { expect, test } from "@/test";
import statisticsRoutes from "../statistics";

test("role matrix scopes child and unrelated leads and honors explicit organization cost permission", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeCustomRole,
  makeAgent,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const parent = await makeTeam(org.id, owner.id);
  const child = await makeTeam(org.id, owner.id, { parentId: parent.id });
  const grandchild = await makeTeam(org.id, owner.id, { parentId: child.id });
  const sibling = await makeTeam(org.id, owner.id, { parentId: parent.id });
  const unrelated = await makeTeam(org.id, owner.id);
  const all = [parent, child, grandchild, sibling, unrelated];
  const agent = await makeAgent({ organizationId: org.id });
  for (const [index, team] of all.entries()) {
    await makeInteraction(agent.id, {
      billingTeamId: team.id,
      userId: owner.id,
      cost: String(index + 1),
    });
  }
  const costRole = await makeCustomRole(org.id, {
    permission: { llmCost: ["read"] },
  });
  const limitRole = await makeCustomRole(org.id, {
    permission: { llmLimit: ["read"] },
  });
  const peopleRole = await makeCustomRole(org.id, {
    permission: { llmCost: ["read"], member: ["read"] },
  });
  const rosterRole = await makeCustomRole(org.id, {
    permission: { member: ["read"] },
  });
  let actor = owner;
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      user: actor,
      organizationId: org.id,
      authMethod: "session",
    });
  });
  await app.register(statisticsRoutes);
  const cases = [
    { name: "organization admin", role: "admin", expected: all },
    {
      name: "parent lead",
      role: "member",
      team: parent,
      expected: [parent, child, grandchild, sibling],
    },
    {
      name: "child lead",
      role: "member",
      team: child,
      expected: [child, grandchild],
    },
    {
      name: "unrelated lead",
      role: "member",
      team: unrelated,
      expected: [unrelated],
    },
    { name: "ordinary member", role: "member", expected: [] },
    { name: "limits reader only", role: limitRole.role, expected: [] },
    { name: "explicit cost reader", role: costRole.role, expected: all },
    { name: "cost and roster reader", role: peopleRole.role, expected: all },
    { name: "roster reader only", role: rosterRole.role, expected: [] },
    {
      name: "child lead with explicit cost permission",
      role: costRole.role,
      team: child,
      expected: all,
    },
  ];
  try {
    for (const scenario of cases) {
      actor = await makeUser();
      await makeMember(actor.id, org.id, { role: scenario.role });
      if (scenario.team)
        await makeTeamMember(scenario.team.id, actor.id, { role: "admin" });
      else await makeTeamMember(child.id, actor.id);
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/team-spend?timeframe=30d",
      });
      expect(response.statusCode, scenario.name).toBe(
        scenario.expected.length ? 200 : 403,
      );
      const personTeams =
        scenario.role === "admin" || scenario.role === peopleRole.role
          ? all
          : scenario.team === parent
            ? [parent, child, grandchild, sibling]
            : scenario.team === child
              ? [child, grandchild]
              : scenario.team === unrelated
                ? [unrelated]
                : [];
      const access = await app.inject({
        method: "GET",
        url: "/api/statistics/team-spend/access",
      });
      expect(access.statusCode).toBe(200);
      expect(access.json().administeredTeamIds.sort(), scenario.name).toEqual(
        (scenario.team === parent
          ? [parent, child, grandchild, sibling]
          : scenario.team === child
            ? [child, grandchild]
            : scenario.team === unrelated
              ? [unrelated]
              : []
        )
          .map((t) => t.id)
          .sort(),
      );
      const persons = await app.inject({
        method: "GET",
        url: "/api/statistics/team-spend?timeframe=30d&includePeople=true",
      });
      expect(persons.statusCode, scenario.name).toBe(
        personTeams.length ? 200 : 403,
      );
      if (personTeams.length) {
        expect(
          persons
            .json()
            .map((r: { teamId: string }) => r.teamId)
            .sort(),
          scenario.name,
        ).toEqual(personTeams.map((t) => t.id).sort());
        for (const row of persons.json())
          expect(row.people).toEqual([
            expect.objectContaining({
              personId: owner.id,
              kind: "person",
              billedSpend: all.findIndex((t) => t.id === row.teamId) + 1,
            }),
          ]);
      }
      if (!scenario.expected.length) continue;
      const rows = response.json();
      for (const row of rows) expect(row).not.toHaveProperty("people");
      expect(
        rows.map((r: { teamId: string }) => r.teamId).sort(),
        scenario.name,
      ).toEqual(scenario.expected.map((t) => t.id).sort());
      for (const row of rows) {
        if (row.parentId)
          expect(
            scenario.expected.map((t) => t.id),
            scenario.name,
          ).toContain(row.parentId);
      }
      const expectedSpend = scenario.expected.reduce(
        (sum, t) => sum + all.findIndex((a) => a.id === t.id) + 1,
        0,
      );
      expect(
        rows.reduce(
          (sum: number, r: { directSpend: number }) => sum + r.directSpend,
          0,
        ),
        scenario.name,
      ).toBe(expectedSpend);
    }
  } finally {
    await app.close();
  }
});

test("team admin sees only payer spend for administered descendants; membership does not move history", async ({
  makeUser,
  makeOrganization,
  makeTeam,
  makeTeamMember,
  makeMember,
  makeAgent,
  makeInteraction,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  await makeMember(user.id, org.id, { role: "member" });
  const parent = await makeTeam(org.id, user.id);
  const child = await makeTeam(org.id, user.id, { parentId: parent.id });
  const other = await makeTeam(org.id, user.id);
  await makeTeamMember(parent.id, user.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: org.id });
  const insert = (
    teamId: string | null,
    cost: string,
    billingMode: "metered" | "subscription" = "metered",
  ) =>
    makeInteraction(agent.id, {
      userId: user.id,
      billingTeamId: teamId,
      cost,
      billingMode,
      type: "openai:chatCompletions",
      model: "synthetic-model",
      inputTokens: 100,
      outputTokens: 20,
    });
  await insert(child.id, "12");
  await insert(child.id, "25", "subscription");
  await insert(other.id, "900");
  await insert(null, "700");
  const otherOrg = await makeOrganization();
  const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
  await makeInteraction(foreignAgent.id, {
    billingTeamId: child.id,
    cost: "999",
    type: "openai:chatCompletions",
    model: "foreign",
  });
  const app = createFastifyInstance();
  let authMethod = "session";
  app.addHook("onRequest", async (request) => {
    Object.assign(request, { user, organizationId: org.id, authMethod });
  });
  await app.register(statisticsRoutes);
  try {
    const get = () =>
      app.inject({
        method: "GET",
        url: "/api/statistics/team-spend?timeframe=30d",
      });
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json();
    expect(rows.map((r: { teamId: string }) => r.teamId).sort()).toEqual(
      [parent.id, child.id].sort(),
    );
    expect(
      rows.find((r: { teamId: string }) => r.teamId === child.id),
    ).toMatchObject({
      directSpend: 12,
      descendantSpend: 0,
      subscriptionValue: 25,
      requests: 2,
    });
    expect(
      rows.find((r: { teamId: string }) => r.teamId === parent.id),
    ).toMatchObject({ directSpend: 0, descendantSpend: 12 });
    await makeTeamMember(child.id, user.id);
    expect(
      (await get())
        .json()
        .find((r: { teamId: string }) => r.teamId === child.id).directSpend,
    ).toBe(12);
    authMethod = "api_key";
    expect((await get()).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/statistics/team-spend?includePeople=true",
        })
      ).statusCode,
    ).toBe(403);
    authMethod = "session";
    await db
      .delete(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, user.id));
    expect((await get()).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});

test("organization cost reader sees zero-spend teams, excludes other organizations", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  await makeMember(user.id, org.id, { role: "admin" });
  const team = await makeTeam(org.id, user.id);
  await makeTeam((await makeOrganization()).id, user.id);
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      user,
      organizationId: org.id,
      authMethod: "session",
    });
  });
  await app.register(statisticsRoutes);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/team-spend?timeframe=30d",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        teamId: team.id,
        directSpend: 0,
        requests: 0,
        models: [],
      }),
    ]);
  } finally {
    await app.close();
  }
});

test("splits enforced model components, merges provider endpoints, honors dates and retains receipts after agent deletion", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
  makeAgent,
  makeInteraction,
}) => {
  const user = await makeUser();
  const org = await makeOrganization();
  await makeMember(user.id, org.id, { role: "admin" });
  const team = await makeTeam(org.id, user.id);
  const agent = await makeAgent({ organizationId: org.id });
  const interaction = await makeInteraction(agent.id, {
    billingTeamId: team.id,
    model: "message-model",
    cost: "9",
    inputTokens: 900,
    outputTokens: 0,
  });
  const component = (
    model: string,
    kind: "message" | "advisor_message",
    cost: string,
    inputTokens: number,
  ) => ({
    id: model,
    model,
    kind,
    cost,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    provider: "openai" as const,
    prices: {
      input: "1",
      output: "1",
      cacheRead: null,
      cacheWrite: null,
      cacheWrite1h: null,
      source: "test",
    },
  });
  await db.insert(schema.interactionBillingTable).values({
    interactionId: interaction.id,
    organizationId: org.id,
    billingTeamId: team.id,
    billingMode: "metered",
    fingerprint: "synthetic-receipt",
    usage: {
      version: 1,
      mode: "enforce",
      status: "complete",
      issues: [],
      cost: "9",
      components: [
        component("message-model", "message", "7", 700),
        component("advisor-model", "advisor_message", "2", 200),
      ],
    },
  });
  await makeInteraction(agent.id, {
    billingTeamId: team.id,
    model: "message-model",
    type: "openai:responses",
    cost: "3",
    inputTokens: 100,
    outputTokens: 0,
  });
  await makeInteraction(agent.id, {
    billingTeamId: team.id,
    model: "outside-range",
    cost: "999",
    createdAt: new Date(Date.now() - 90 * 86400000),
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      user,
      organizationId: org.id,
      authMethod: "session",
    });
  });
  await app.register(statisticsRoutes);
  try {
    const get = async () => {
      const r = await app.inject({
        method: "GET",
        url: "/api/statistics/team-spend?timeframe=30d&includePeople=true",
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json()[0];
    };
    const before = await get();
    expect(before.people).toEqual([
      expect.objectContaining({
        kind: "unattributed",
        billedSpend: 12,
        requests: 2,
        tokens: 1000,
      }),
    ]);
    const allTime = await app.inject({
      method: "GET",
      url: "/api/statistics/team-spend?timeframe=all",
    });
    expect(allTime.statusCode).toBe(200);
    for (const model of allTime.json()[0].models) {
      for (const point of model.timeSeries)
        expect(point.timestamp.slice(8)).toBe("01T00:00:00Z");
    }
    expect(before).toMatchObject({
      directSpend: 12,
      requests: 2,
      tokens: 1000,
    });
    expect(before.models).toHaveLength(2);
    for (const model of before.models) {
      expect(
        model.timeSeries.reduce(
          (sum: number, point: { billedSpend: number }) =>
            sum + point.billedSpend,
          0,
        ),
      ).toBe(model.billedSpend);
      expect(
        model.timeSeries.reduce(
          (sum: number, point: { requests: number }) => sum + point.requests,
          0,
        ),
      ).toBe(model.requests);
    }
    expect(before.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "message-model",
          billedSpend: 10,
          requests: 2,
          tokens: 800,
        }),
        expect.objectContaining({
          model: "advisor-model",
          billedSpend: 2,
          requests: 0,
          tokens: 200,
        }),
      ]),
    );
    await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(await get()).toMatchObject({
      directSpend: 9,
      requests: 1,
      tokens: 900,
    });
  } finally {
    await app.close();
  }
});

test("person totals retain unknown and service principals without moving membership history or double-counting model buckets", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeAgent,
  makeInteraction,
  makeServiceAccount,
}) => {
  const org = await makeOrganization();
  const lead = await makeUser();
  const person = await makeUser({ name: "Recorded person" });
  await makeMember(lead.id, org.id, { role: "member" });
  const parent = await makeTeam(org.id, lead.id);
  const child = await makeTeam(org.id, lead.id, { parentId: parent.id });
  const other = await makeTeam(org.id, lead.id);
  await makeTeamMember(parent.id, lead.id, { role: "admin" });
  await makeTeamMember(other.id, person.id);
  const service = await makeServiceAccount(org.id, { name: "Batch worker" });
  const agent = await makeAgent({ organizationId: org.id });
  const at = new Date(Date.now() - 86400000);
  const add = (values: Partial<typeof schema.interactionsTable.$inferInsert>) =>
    makeInteraction(agent.id, {
      billingTeamId: child.id,
      userId: person.id,
      model: "example",
      type: "openai:chatCompletions",
      cost: "2",
      inputTokens: 100,
      outputTokens: 20,
      createdAt: at,
      ...values,
    });
  await add({ cost: "6", cacheWriteTokens: 300 });
  await add({ cost: "0.1" });
  await add({ cost: "0.2" });
  await add({ type: "openai:responses" });
  await add({
    cost: "5",
    billingMode: "subscription",
    inputTokensEstimated: true,
  });
  await add({ userId: null, cost: "3" });
  await add({ userId: null, cost: null });
  await add({ userId: null, serviceAccountId: service.id, cost: "4" });
  await add({ billingTeamId: other.id, cost: "900" });
  await add({ createdAt: new Date(Date.now() - 90 * 86400000), cost: "999" });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      user: lead,
      organizationId: org.id,
      authMethod: "session",
    });
  });
  await app.register(statisticsRoutes);
  try {
    const get = async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/team-spend?timeframe=30d&includePeople=true",
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    const rows = await get();
    const result = rows.find((r: { teamId: string }) => r.teamId === child.id);
    expect(result).toMatchObject({
      directSpend: 15.3,
      requests: 8,
      tokens: 1160,
      subscriptionValue: 5,
      unpricedRequests: 1,
    });
    expect(result.people).toEqual([
      expect.objectContaining({
        personId: person.id,
        kind: "person",
        billedSpend: 8.3,
        subscriptionValue: 5,
        requests: 5,
      }),
      expect.objectContaining({
        personId: service.id,
        kind: "service_account",
        personName: "Batch worker",
        billedSpend: 4,
        requests: 1,
      }),
      expect.objectContaining({
        personId: null,
        kind: "unattributed",
        billedSpend: 3,
        requests: 2,
        unpricedRequests: 1,
      }),
    ]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].timeSeries).toEqual([
      expect.objectContaining({ billedSpend: 15.3, requests: 8, tokens: 1160 }),
    ]);
    expect(
      rows.find((r: { teamId: string }) => r.teamId === parent.id),
    ).toMatchObject({ directSpend: 0, descendantSpend: 15.3, people: [] });
    await makeTeamMember(child.id, person.id);
    expect(
      (await get()).find((r: { teamId: string }) => r.teamId === child.id),
    ).toMatchObject({ directSpend: 15.3, people: result.people });
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, person.id));
    const after = (await get()).find(
      (r: { teamId: string }) => r.teamId === child.id,
    );
    expect(after.directSpend).toBe(15.3);
    expect(after.people).toEqual([
      expect.objectContaining({
        personId: null,
        kind: "unattributed",
        billedSpend: 11.3,
        requests: 7,
        subscriptionValue: 5,
      }),
      expect.objectContaining({
        personId: service.id,
        kind: "service_account",
        billedSpend: 4,
      }),
    ]);
  } finally {
    await app.close();
  }
});
