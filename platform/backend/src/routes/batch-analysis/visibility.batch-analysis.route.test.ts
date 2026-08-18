import { BatchAnalysisModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const columns = [
  { key: "topic", name: "Topic", prompt: "What is it about?", format: "text" },
];

/**
 * Who can see an analysis, and who can act on one they cannot see. An analysis
 * names an agent whose credential its runs spend and whose cells quote source
 * documents, so "can read" and "can run" have to be the same answer.
 */
describe("batch analysis visibility", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let agentId: string;

  async function bootAs(actor: User) {
    if (app) await app.close();
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = actor;
    });
    const { default: batchAnalysisRoutes } = await import(
      "./batch-analysis.routes"
    );
    await app.register(batchAnalysisRoutes);
  }

  function create(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/batch-analyses",
      payload: { name: "Vendor review", agentId, columns, ...overrides },
    });
  }

  const list = (query = "") =>
    app.inject({ method: "GET", url: `/api/batch-analyses${query}` });

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    owner = await makeUser();
    const agent = await makeAgent({ organizationId });
    agentId = agent.id;
    await bootAs(owner);
  });

  afterEach(async () => {
    await app.close();
  });

  test("defaults to personal, and lists for its creator", async () => {
    const created = await create();
    expect(created.json()).toMatchObject({ scope: "personal", teamIds: [] });

    expect(list().then((r) => r.json().data)).resolves.toHaveLength(1);
  });

  test("a personal analysis is invisible to everyone else", async ({
    makeUser,
  }) => {
    const { id } = (await create()).json();

    await bootAs(await makeUser({ email: "stranger@test.com" }));

    expect((await list()).json().data).toEqual([]);
    expect(
      (await app.inject({ url: `/api/batch-analyses/${id}` })).statusCode,
    ).toBe(404);
  });

  test("an org-scoped analysis is visible to everyone", async ({
    makeUser,
  }) => {
    const { id } = (await create({ scope: "org" })).json();

    await bootAs(await makeUser({ email: "colleague@test.com" }));

    expect((await list()).json().data).toHaveLength(1);
    expect(
      (await app.inject({ url: `/api/batch-analyses/${id}` })).statusCode,
    ).toBe(200);
  });

  test("a team-scoped analysis reaches that team's members only", async ({
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, owner.id);
    const { id } = (await create({ scope: "team", teamIds: [team.id] })).json();

    const member = await makeUser({ email: "member@test.com" });
    await makeTeamMember(team.id, member.id);
    await bootAs(member);
    expect((await list()).json().data).toHaveLength(1);

    await bootAs(await makeUser({ email: "outsider@test.com" }));
    expect((await list()).json().data).toEqual([]);
    expect(
      (await app.inject({ url: `/api/batch-analyses/${id}` })).statusCode,
    ).toBe(404);
  });

  test("running an analysis you cannot see is refused", async ({
    makeUser,
  }) => {
    const { id } = (await create()).json();

    await bootAs(await makeUser({ email: "stranger@test.com" }));

    // Reading it 404s, so dispatching a run that spends its agent's credential
    // has to 404 too.
    const run = await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${id}/runs`,
    });
    expect(run.statusCode).toBe(404);
  });

  test("editing an analysis you cannot see is refused", async ({
    makeUser,
  }) => {
    const { id } = (await create()).json();

    await bootAs(await makeUser({ email: "stranger@test.com" }));

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${id}`,
      payload: { name: "Renamed", agentId, columns, scope: "org" },
    });
    expect(patched.statusCode).toBe(404);
  });

  test("deleting an analysis you cannot see is refused", async ({
    makeUser,
  }) => {
    const { id } = (await create()).json();

    await bootAs(await makeUser({ email: "stranger@test.com" }));

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/batch-analyses/${id}`,
    });
    expect(deleted.statusCode).toBe(404);
  });

  test("search filters by name", async () => {
    await create({ name: "Vendor security review" });
    await create({ name: "Lease abstraction" });

    const found = (await list("?search=lease")).json().data;
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Lease abstraction");
  });

  test("an edit can change every part of the configuration", async ({
    makeAgent,
    makeTeam,
  }) => {
    const { id } = (await create()).json();
    const otherAgent = await makeAgent({ organizationId });
    const team = await makeTeam(organizationId, owner.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${id}`,
      payload: {
        name: "Renamed",
        agentId: otherAgent.id,
        columns: [
          { key: "risk", name: "Risk", prompt: "How risky?", format: "text" },
        ],
        scope: "team",
        teamIds: [team.id],
      },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: "Renamed",
      agentId: otherAgent.id,
      scope: "team",
      teamIds: [team.id],
    });
    expect(patched.json().columns).toHaveLength(1);
  });

  test("switching away from team scope drops the team assignments", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, owner.id);
    // The owner has to be in the team to still see their own analysis after
    // sharing it there — team scope replaces personal scope, it does not add
    // to it.
    await makeTeamMember(team.id, owner.id);
    const { id } = (await create({ scope: "team", teamIds: [team.id] })).json();

    await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${id}`,
      payload: { name: "Vendor review", agentId, columns, scope: "personal" },
    });

    // Stale rows would silently re-share the analysis if it ever went back to
    // team scope.
    const detail = await app.inject({ url: `/api/batch-analyses/${id}` });
    expect(detail.json().analysis.teamIds).toEqual([]);
  });

  test("an agent from another organization is refused", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });

    const created = await create({ agentId: foreignAgent.id });
    expect(created.statusCode).toBe(404);
  });

  test("a team from another organization is refused", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser({ email: "other-org@test.com" });
    const foreignTeam = await makeTeam(otherOrg.id, otherUser.id);

    const created = await create({
      scope: "team",
      teamIds: [foreignTeam.id],
    });
    expect(created.statusCode).toBe(400);
  });

  test("a row can be deleted, and its cells go with it", async () => {
    const { id } = (await create()).json();
    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${id}/rows`,
      payload: {
        rows: [{ label: "doc", source: { type: "inline_text", text: "hi" } }],
      },
    });
    const detail = (
      await app.inject({ url: `/api/batch-analyses/${id}` })
    ).json();
    const rowId = detail.rows[0].id;
    await BatchAnalysisModel.ensureCells({
      rowIds: [rowId],
      columnKeys: ["topic"],
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/batch-analyses/${id}/rows/${rowId}`,
    });
    expect(deleted.statusCode).toBe(200);

    const after = (
      await app.inject({ url: `/api/batch-analyses/${id}` })
    ).json();
    expect(after.rows).toEqual([]);
    // Orphaned cells would keep counting in progress totals forever.
    expect(after.cells).toEqual([]);
  });

  test("deleting a row of an analysis you cannot see is refused", async ({
    makeUser,
  }) => {
    const { id } = (await create()).json();
    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${id}/rows`,
      payload: {
        rows: [{ label: "doc", source: { type: "inline_text", text: "hi" } }],
      },
    });
    const detail = (
      await app.inject({ url: `/api/batch-analyses/${id}` })
    ).json();
    const rowId = detail.rows[0].id;

    await bootAs(await makeUser({ email: "stranger@test.com" }));
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/batch-analyses/${id}/rows/${rowId}`,
    });
    expect(deleted.statusCode).toBe(404);
  });

  test("removing a column drops its cells from the totals", async () => {
    const { id } = (await create()).json();
    await app.inject({
      method: "POST",
      url: `/api/batch-analyses/${id}/rows`,
      payload: {
        rows: [{ label: "doc", source: { type: "inline_text", text: "hi" } }],
      },
    });
    const detail = (
      await app.inject({ url: `/api/batch-analyses/${id}` })
    ).json();
    await BatchAnalysisModel.ensureCells({
      rowIds: [detail.rows[0].id],
      columnKeys: ["topic"],
    });

    // Replace the "topic" column with a different one.
    await app.inject({
      method: "PATCH",
      url: `/api/batch-analyses/${id}`,
      payload: {
        name: "Vendor review",
        agentId,
        columns: [
          { key: "risk", name: "Risk", prompt: "How risky?", format: "text" },
        ],
        scope: "personal",
      },
    });

    const after = (
      await app.inject({ url: `/api/batch-analyses/${id}` })
    ).json();
    // The old column's cell is gone; the new column has no cells until a run.
    expect(after.cells).toEqual([]);
  });
});
