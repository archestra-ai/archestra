// Compatibility coverage for legacy sharing before migration; scoped grants are covered by the backfill and scoped route tests.
import ModelModel from "@/models/model";
import ModelTeamModel from "@/models/model-team";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { describe, expect, test } from "@/test";
import { checkModelTeamAccess } from "./model-team-access";

async function createModel(modelId: string) {
  return await ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    description: modelId,
    contextLength: 200_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    promptPricePerToken: "0.000003",
    completionPricePerToken: "0.000015",
    ignored: false,
    lastSyncedAt: new Date(),
  });
}

describe("checkModelTeamAccess", () => {
  test("service-account model use grants are exact, distinct from read, and revoked immediately", async ({
    makeOrganization,
    makeTeam,
    makeUser,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const owner = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const model = await createModel("restricted-scoped-model");
    const other = await createModel("other-restricted-model");
    await ModelTeamModel.syncModelTeams(model.id, [team.id]);
    await ModelTeamModel.syncModelTeams(other.id, [team.id]);
    const role = await makeCustomRole(org.id, { permission: {} });
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "Model automation",
      role: role.role,
      createdBy: owner.id,
    });
    const key = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const subject = { type: "serviceAccount" as const, id: account.id };
    const context = {
      organizationId: org.id,
      provider: "anthropic" as const,
      modelId: model.modelId,
      authenticatedUserId: `service-account:${account.id}`,
      userTeamIds: [],
    };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: 0,
      grants: [{ subject, actions: ["read"] }],
    });
    expect((await checkModelTeamAccess(context)).allowed).toBe(false);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: 1,
      grants: [{ subject, actions: ["use"] }],
    });
    expect((await checkModelTeamAccess(context)).allowed).toBe(true);
    expect(
      (await checkModelTeamAccess({ ...context, modelId: other.modelId }))
        .allowed,
    ).toBe(false);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: 2,
      grants: [],
    });
    expect((await checkModelTeamAccess(context)).allowed).toBe(false);
  });

  test("allows unrestricted and unknown models for anyone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    await createModel("claude-open");

    for (const modelId of ["claude-open", "totally-unknown-model"]) {
      const result = await checkModelTeamAccess({
        provider: "anthropic",
        modelId,
        organizationId: org.id,
        authenticatedUserId: undefined,
        userTeamIds: [],
      });
      expect(result).toEqual({ allowed: true });
    }
  });

  test("only allows restricted models for members of the restriction teams", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const model = await createModel("claude-frontier");

    const insider = await makeUser();
    await makeMember(insider.id, org.id);
    const outsider = await makeUser();
    await makeMember(outsider.id, org.id);

    const devTeam = await makeTeam(org.id, insider.id);
    await makeTeamMember(devTeam.id, insider.id);
    await ModelTeamModel.syncModelTeams(model.id, [devTeam.id]);

    const insiderResult = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: insider.id,
      userTeamIds: [devTeam.id],
    });
    expect(insiderResult).toEqual({ allowed: true });

    const outsiderResult = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: outsider.id,
      userTeamIds: [],
    });
    expect(outsiderResult).toMatchObject({ allowed: false });

    const anonymousResult = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: undefined,
      userTeamIds: [],
    });
    expect(anonymousResult).toMatchObject({ allowed: false });
  });

  test("denies restricted models without an authenticated identity, even when team ids match", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const model = await createModel("claude-frontier");

    const insider = await makeUser();
    await makeMember(insider.id, org.id);
    const devTeam = await makeTeam(org.id, insider.id);
    await makeTeamMember(devTeam.id, insider.id);
    await ModelTeamModel.syncModelTeams(model.id, [devTeam.id]);

    // Team ids of a genuine member, but no credential proved who is calling.
    // Membership alone must not unlock the model, otherwise an unauthenticated
    // caller naming that member in a header would inherit their access.
    const result = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: undefined,
      userTeamIds: [devTeam.id],
    });
    expect(result).toMatchObject({ allowed: false });
  });

  test("allows restricted models for org admins outside the team", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const model = await createModel("claude-frontier");

    const teamOwner = await makeUser();
    await makeMember(teamOwner.id, org.id);
    const devTeam = await makeTeam(org.id, teamOwner.id);
    await ModelTeamModel.syncModelTeams(model.id, [devTeam.id]);

    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });

    const result = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: admin.id,
      userTeamIds: [],
    });
    expect(result).toEqual({ allowed: true });
  });
});
