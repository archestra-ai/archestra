import type { ResourcePermissionGrant } from "@archestra/shared";
import ModelModel from "@/models/model";
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

async function setModelGrants(params: {
  organizationId: string;
  modelId: string;
  grants: ResourcePermissionGrant[];
}) {
  const key = {
    organizationId: params.organizationId,
    resource: "llmModel" as const,
    scope: params.modelId,
  };
  const current = await ResourcePermissionPolicyModel.find(key);
  const saved = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: current?.revision ?? 0,
    grants: params.grants,
  });
  if (!saved) throw new Error("failed to write model grants");
}

describe("checkModelTeamAccess", () => {
  test("service-account model use grants are exact, distinct from read, and revoked immediately", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const model = await createModel("restricted-scoped-model");
    const other = await createModel("other-restricted-model");
    const role = await makeCustomRole(org.id, { permission: {} });
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "Model automation",
      role: role.role,
      createdBy: owner.id,
    });
    const subject = { type: "serviceAccount" as const, id: account.id };
    const context = {
      organizationId: org.id,
      provider: "anthropic" as const,
      modelId: model.modelId,
      authenticatedUserId: `service-account:${account.id}`,
    };
    const grant = (grants: ResourcePermissionGrant[]) =>
      setModelGrants({ organizationId: org.id, modelId: model.id, grants });
    // A new model opens to the whole organization; close the other one so it
    // shows that a grant on one model reaches no other.
    await setModelGrants({
      organizationId: org.id,
      modelId: other.id,
      grants: [],
    });

    await grant([{ subject, actions: ["read"] }]);
    expect((await checkModelTeamAccess(context)).allowed).toBe(false);
    await grant([{ subject, actions: ["read", "use"] }]);
    expect((await checkModelTeamAccess(context)).allowed).toBe(true);
    expect(
      (await checkModelTeamAccess({ ...context, modelId: other.modelId }))
        .allowed,
    ).toBe(false);
    await grant([]);
    expect((await checkModelTeamAccess(context)).allowed).toBe(false);
  });

  test("allows unknown models for anyone", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const result = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "totally-unknown-model",
      organizationId: org.id,
      authenticatedUserId: undefined,
    });
    expect(result).toEqual({ allowed: true });
  });

  test("a team grant reaches its members, never an unauthenticated caller", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const model = await createModel("claude-frontier");
    const insider = await makeUser();
    await makeMember(insider.id, org.id);
    const outsider = await makeUser();
    await makeMember(outsider.id, org.id);
    const devTeam = await makeTeam(org.id, insider.id);
    await makeTeamMember(devTeam.id, insider.id);
    await setModelGrants({
      organizationId: org.id,
      modelId: model.id,
      grants: [
        { subject: { type: "team", id: devTeam.id }, actions: ["read", "use"] },
      ],
    });
    const check = (authenticatedUserId: string | undefined) =>
      checkModelTeamAccess({
        provider: "anthropic",
        modelId: "claude-frontier",
        organizationId: org.id,
        authenticatedUserId,
      });

    expect(await check(insider.id)).toEqual({ allowed: true });
    expect(await check(outsider.id)).toMatchObject({ allowed: false });
    // No credential proved who is calling, so a team grant cannot apply.
    expect(await check(undefined)).toMatchObject({ allowed: false });

    // An organization-wide grant is the one thing such a caller may exercise.
    await setModelGrants({
      organizationId: org.id,
      modelId: model.id,
      grants: [
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    });
    expect(await check(undefined)).toEqual({ allowed: true });
  });

  test("org admins reach every model through their wildcard grant", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const model = await createModel("claude-frontier");
    await setModelGrants({
      organizationId: org.id,
      modelId: model.id,
      grants: [],
    });
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });

    const result = await checkModelTeamAccess({
      provider: "anthropic",
      modelId: "claude-frontier",
      organizationId: org.id,
      authenticatedUserId: admin.id,
    });
    expect(result).toEqual({ allowed: true });
  });

  test("a member with no model grant keeps every model an unscoped deployment let them use", async ({
    makeOrganization,
    makeMember,
    makeUser,
  }) => {
    // Scoped permissions add flexibility, never reach: a plain member holds no
    // llmModel grant of their own, so these two cases are exactly the access
    // that must survive the cutover.
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const context = {
      provider: "openai" as const,
      organizationId: org.id,
      authenticatedUserId: member.id,
    };

    // An id no catalog lists carries no restriction to enforce.
    expect(
      await checkModelTeamAccess({ ...context, modelId: "never-catalogued" }),
    ).toEqual({ allowed: true });

    // A model the proxy catalogues on first sighting is published to the
    // organization as it is written, so the request that discovered it — and
    // every later one — still goes through.
    const discovered = await ModelModel.ensureModelExists(
      "discovered-by-proxy",
      "openai",
    );
    expect(discovered).not.toBeNull();
    expect(
      await checkModelTeamAccess({
        ...context,
        modelId: "discovered-by-proxy",
      }),
    ).toEqual({ allowed: true });
  });
});
