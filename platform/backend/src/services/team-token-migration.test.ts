import { ServiceAccountModel, TeamTokenModel } from "@/models";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import { describe, expect, test } from "@/test";
import { migrateTeamTokensToServiceAccounts } from "./team-token-migration";

describe("migrateTeamTokensToServiceAccounts", () => {
  test("moves the organization token onto an org-wide service account that keeps its value", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, access: "org" });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await migrateTeamTokensToServiceAccounts();

    const accounts = await ServiceAccountModel.listByOrganizationId(org.id);
    expect(accounts).toEqual([
      expect.objectContaining({ name: "Organization token", teamId: null }),
    ]);
    const auth = await validateMCPGatewayToken(agent.id, value);
    expect(auth).toMatchObject({
      organizationId: org.id,
      serviceAccountId: accounts[0].id,
      teamId: null,
      isOrganizationToken: false,
    });
  });

  test("moves a team token onto a service account acting for that team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Platform" });
    const agent = await makeAgent({
      organizationId: org.id,
      access: { teams: [team.id] },
    });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Team Token",
      teamId: team.id,
    });

    await migrateTeamTokensToServiceAccounts();

    const accounts = await ServiceAccountModel.listByOrganizationId(org.id);
    expect(accounts).toEqual([
      expect.objectContaining({
        name: "Team token: Platform",
        teamId: team.id,
      }),
    ]);
    // The team grant on the agent still reaches the migrated token.
    const auth = await validateMCPGatewayToken(agent.id, value);
    expect(auth).toMatchObject({
      organizationId: org.id,
      serviceAccountId: accounts[0].id,
      teamId: team.id,
      isOrganizationToken: false,
    });
  });

  test("running it again creates nothing new", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await migrateTeamTokensToServiceAccounts();
    const first = await ServiceAccountModel.listByOrganizationId(org.id);
    await migrateTeamTokensToServiceAccounts();
    const second = await ServiceAccountModel.listByOrganizationId(org.id);

    expect(first).toHaveLength(1);
    expect(second.map((a) => a.id)).toEqual(first.map((a) => a.id));
  });

  test("suffixes the name when an account already uses it", async ({
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const org = await makeOrganization();
    const existing = await makeServiceAccountToken({
      organizationId: org.id,
      name: "Organization token",
    });
    const { token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await migrateTeamTokensToServiceAccounts();

    const migrated = (
      await ServiceAccountModel.listByOrganizationId(org.id)
    ).filter((a) => a.id !== existing.serviceAccount.id);
    expect(migrated.map((a) => a.name)).toEqual([
      `Organization token (${token.id.slice(0, 8)})`,
    ]);
  });
});
