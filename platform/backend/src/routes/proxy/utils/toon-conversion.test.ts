import { OrganizationModel } from "@/models";
import { describe, expect, test } from "@/test";
import { shouldApplyToonCompression } from "./toon-conversion";

/**
 * The TOON cascade: organization-wide enablement (scope "organization" +
 * org flag) compresses everything; otherwise a team-level opt-in on any of
 * the agent's teams enables compression regardless of the org's compression
 * scope, so a stored team flag is never silently inert (#4454).
 */
describe("shouldApplyToonCompression", () => {
  test("organization scope with org flag on compresses regardless of team flags", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      compressionScope: "organization",
      convertToolResultsToToon: true,
    });
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id, {
      convertToolResultsToToon: false,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      teams: [team.id],
    });

    expect(await shouldApplyToonCompression(agent.id)).toBe(true);
  });

  test("team opt-in is honored even when org scope is 'organization' with org flag off", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      compressionScope: "organization",
      convertToolResultsToToon: false,
    });
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id, {
      convertToolResultsToToon: true,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      teams: [team.id],
    });

    expect(await shouldApplyToonCompression(agent.id)).toBe(true);
  });

  test("no compression when org flag is off and no team opted in", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      compressionScope: "organization",
      convertToolResultsToToon: false,
    });
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id, {
      convertToolResultsToToon: false,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      teams: [team.id],
    });

    expect(await shouldApplyToonCompression(agent.id)).toBe(false);
  });

  test("team scope compresses agents whose team opted in", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      compressionScope: "team",
      convertToolResultsToToon: false,
    });
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id, {
      convertToolResultsToToon: true,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      teams: [team.id],
    });

    expect(await shouldApplyToonCompression(agent.id)).toBe(true);
  });

  test("team scope without any team opt-in disables compression even if the org flag is on", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    // Under team scope the org flag is not an org-wide switch; only team
    // opt-ins count.
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      compressionScope: "team",
      convertToolResultsToToon: true,
    });
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id, {
      convertToolResultsToToon: false,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      teams: [team.id],
    });

    expect(await shouldApplyToonCompression(agent.id)).toBe(false);
  });
});
