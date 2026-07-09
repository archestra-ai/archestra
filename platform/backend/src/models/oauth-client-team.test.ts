import { expect } from "vitest";
import { test } from "@/test";
import McpOauthClientModel from "./mcp-oauth-client";
import OauthClientTeamModel from "./oauth-client-team";

async function makeClient(params: {
  organizationId: string;
  authorId: string;
  name?: string;
  scope?: "personal" | "team" | "org";
  teams?: string[];
}) {
  const { oauthClient } = await McpOauthClientModel.create({
    organizationId: params.organizationId,
    authorId: params.authorId,
    name: params.name ?? `client-${crypto.randomUUID().slice(0, 8)}`,
    scope: params.scope,
    teams: params.teams,
  });
  return oauthClient;
}

test("syncTeams replaces and clears team assignments", async ({
  makeOrganization,
  makeUser,
  makeTeam,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const team1 = await makeTeam(org.id, user.id);
  const team2 = await makeTeam(org.id, user.id);

  const client = await makeClient({
    organizationId: org.id,
    authorId: user.id,
    scope: "team",
    teams: [team1.id],
  });

  let teams = (
    await OauthClientTeamModel.getTeamDetailsForClients([client.id])
  ).get(client.id);
  expect(teams?.map((t) => t.id)).toEqual([team1.id]);

  // Replace with team2
  await OauthClientTeamModel.syncTeams(client.id, [team2.id]);
  teams = (
    await OauthClientTeamModel.getTeamDetailsForClients([client.id])
  ).get(client.id);
  expect(teams?.map((t) => t.id)).toEqual([team2.id]);

  // Clear all
  await OauthClientTeamModel.syncTeams(client.id, []);
  teams = (
    await OauthClientTeamModel.getTeamDetailsForClients([client.id])
  ).get(client.id);
  expect(teams).toEqual([]);
});

test("getTeamDetailsForClients batches and returns every requested id", async ({
  makeOrganization,
  makeUser,
  makeTeam,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const teamA = await makeTeam(org.id, user.id, { name: "Team A" });
  const teamB = await makeTeam(org.id, user.id, { name: "Team B" });

  const assigned = await makeClient({
    organizationId: org.id,
    authorId: user.id,
    scope: "team",
    teams: [teamA.id, teamB.id],
  });
  const unassigned = await makeClient({
    organizationId: org.id,
    authorId: user.id,
  });

  const map = await OauthClientTeamModel.getTeamDetailsForClients([
    assigned.id,
    unassigned.id,
  ]);

  expect([...map.keys()].sort()).toEqual([assigned.id, unassigned.id].sort());
  expect(
    map
      .get(assigned.id)
      ?.map((t) => t.id)
      .sort(),
  ).toEqual([teamA.id, teamB.id].sort());
  expect(
    map
      .get(assigned.id)
      ?.map((t) => t.name)
      .sort(),
  ).toEqual(["Team A", "Team B"]);
  expect(map.get(unassigned.id)).toEqual([]);

  // Empty input → empty map, no query.
  expect((await OauthClientTeamModel.getTeamDetailsForClients([])).size).toBe(
    0,
  );
});

test("findAllByOrganization viewer filtering: non-admin sees org, own personal, and their teams' clients only", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeTeamMember,
}) => {
  const org = await makeOrganization();
  const viewer = await makeUser();
  const otherUser = await makeUser();
  const myTeam = await makeTeam(org.id, viewer.id);
  await makeTeamMember(myTeam.id, viewer.id);
  const otherTeam = await makeTeam(org.id, otherUser.id);

  const orgClient = await makeClient({
    organizationId: org.id,
    authorId: otherUser.id,
    scope: "org",
  });
  const ownPersonal = await makeClient({
    organizationId: org.id,
    authorId: viewer.id,
    scope: "personal",
  });
  const foreignPersonal = await makeClient({
    organizationId: org.id,
    authorId: otherUser.id,
    scope: "personal",
  });
  const myTeamClient = await makeClient({
    organizationId: org.id,
    authorId: otherUser.id,
    scope: "team",
    teams: [myTeam.id],
  });
  const foreignTeamClient = await makeClient({
    organizationId: org.id,
    authorId: otherUser.id,
    scope: "team",
    teams: [otherTeam.id],
  });

  const visible = await McpOauthClientModel.findAllByOrganization({
    organizationId: org.id,
    viewer: { userId: viewer.id, isAdmin: false },
  });
  const visibleIds = visible.map((c) => c.id);

  expect(visibleIds).toContain(orgClient.id);
  expect(visibleIds).toContain(ownPersonal.id);
  expect(visibleIds).toContain(myTeamClient.id);
  expect(visibleIds).not.toContain(foreignPersonal.id);
  expect(visibleIds).not.toContain(foreignTeamClient.id);

  // Admin viewer is unfiltered.
  const adminVisible = await McpOauthClientModel.findAllByOrganization({
    organizationId: org.id,
    viewer: { userId: viewer.id, isAdmin: true },
  });
  expect(adminVisible.map((c) => c.id).sort()).toEqual(
    [
      orgClient.id,
      ownPersonal.id,
      foreignPersonal.id,
      myTeamClient.id,
      foreignTeamClient.id,
    ].sort(),
  );

  // Omitted viewer (internal callers) is unfiltered too.
  const unfiltered = await McpOauthClientModel.findAllByOrganization({
    organizationId: org.id,
  });
  expect(unfiltered.map((c) => c.id).sort()).toEqual(
    adminVisible.map((c) => c.id).sort(),
  );
});
