import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { checkModelTeamAccess } from "@/routes/proxy/utils/model-team-access";
import {
  getGuardrailsDeployment,
  getGuardrailsDeploymentFromSnapshot,
} from "@/services/guardrails-deployment";
import { expect, test } from "@/test";
import AttributionLabelModel from "./attribution-label";
import { VirtualApiKeyLabelModel } from "./entity-labels";
import GuardrailsDeploymentModel from "./guardrails-deployment";
import MemberModel from "./member";
import ModelModel from "./model";
import ProxyRequestContextModel from "./proxy-request-context";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamModel from "./team";
import TeamLabelModel from "./team-label";

test("one request snapshot preserves scoped model, team, label and deployment metadata", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeVirtualApiKey,
}) => {
  const organization = await makeOrganization();
  const foreign = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const team = await makeTeam(organization.id, user.id);
  const foreignTeam = await makeTeam(foreign.id, user.id);
  await makeTeamMember(team.id, user.id);
  await makeTeamMember(foreignTeam.id, user.id);
  await TeamLabelModel.syncTeamLabels(team.id, [
    { key: "cost_center", value: "team" },
  ]);
  const key = await makeVirtualApiKey(organization.id);
  await VirtualApiKeyLabelModel.syncLabels(key.id, [
    { key: "cost_center", value: "key" },
  ]);
  const model = await ModelModel.create({
    inputModalities: ["text"],
    outputModalities: ["text"],
    externalId: "openai/snapshot-test",
    provider: "openai",
    modelId: "snapshot-test",
  });
  const params = {
    organizationId: organization.id,
    userId: user.id,
    billingTeamId: team.id,
    virtualKeyId: key.id,
    provider: "openai" as const,
    modelId: model.modelId,
  };
  const context = await ProxyRequestContextModel.read(params);
  expect(context.model).toEqual(
    await ModelModel.findIdentityByProviderAndModelId(
      params.provider,
      params.modelId,
    ),
  );
  expect(
    await getGuardrailsDeploymentFromSnapshot({ row: context.guardrails }),
  ).toEqual(await getGuardrailsDeployment());
  expect(context.userTeams).toEqual(
    await TeamModel.getTeamLabelInfoForUser(params),
  );
  expect(context.userTeams.map(({ id }) => id)).toEqual([team.id]);
  expect(context.attributionRows).toEqual(
    await AttributionLabelModel.findForRequest(params),
  );
  expect(context.modelPolicies).toEqual(
    (
      await ResourcePermissionPolicyModel.findApplicable({
        organizationId: organization.id,
        resource: "llmModel",
        scope: model.id,
      })
    ).map(({ scope, grants, legacyOrganizationAudience }) => ({
      scope,
      grants,
      legacyOrganizationAudience,
    })),
  );

  const foreignContext = await ProxyRequestContextModel.read({
    ...params,
    organizationId: foreign.id,
    userId: undefined,
  });
  expect(foreignContext.userTeams).toEqual([]);
  expect(foreignContext.attributionRows).toEqual([]);
  expect(
    (
      await ProxyRequestContextModel.read({
        ...params,
        modelId: "unseen-model",
      })
    ).model,
  ).toBeNull();

  await GuardrailsDeploymentModel.set({
    enabled: true,
    unsupportedClientAction: "block",
    breakTheGlassEnabled: false,
  });
  expect((await ProxyRequestContextModel.read(params)).guardrails).toEqual(
    await GuardrailsDeploymentModel.get(),
  );
  await TeamLabelModel.syncTeamLabels(team.id, [
    { key: "cost_center", value: "changed" },
  ]);
  await VirtualApiKeyLabelModel.syncLabels(key.id, []);
  const refreshed = await ProxyRequestContextModel.read(params);
  expect(refreshed.attributionRows).toEqual([
    { key: "cost_center", value: "changed", priority: 2 },
  ]);
  expect(refreshed.userTeams[0].labels[0].value).toBe("changed");
  await TeamModel.removeMember(team.id, user.id);
  expect((await ProxyRequestContextModel.read(params)).userTeams).toEqual([]);
});

test("batched model policy authorization observes grant and membership revocation on the next request", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const foreign = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const model = await ModelModel.create({
    inputModalities: ["text"],
    outputModalities: ["text"],
    externalId: "openai/snapshot-revocation",
    provider: "openai",
    modelId: "snapshot-revocation",
  });
  const params = {
    organizationId: org.id,
    provider: "openai" as const,
    modelId: model.modelId,
    userId: user.id,
  };
  const authorize = async (authenticatedUserId: string | null = user.id) => {
    const context = await ProxyRequestContextModel.read(params);
    return checkModelTeamAccess({
      ...params,
      authenticatedUserId: authenticatedUserId ?? undefined,
      catalogModel: context.model ?? undefined,
      policySnapshot: {
        organizationId: org.id,
        modelId: model.id,
        policies: context.modelPolicies,
      },
    });
  };
  expect(await authorize()).toEqual({ allowed: true });
  await MemberModel.deleteAllByUserId(user.id);
  expect((await authorize()).allowed).toBe(false);
  await makeMember(user.id, org.id);
  expect(await authorize()).toEqual({ allowed: true });
  const policyKey = {
    organizationId: org.id,
    resource: "llmModel" as const,
    scope: model.id,
  };
  const current = await ResourcePermissionPolicyModel.find(policyKey);
  await ResourcePermissionPolicyModel.replace({
    ...policyKey,
    revision: current?.revision ?? 0,
    grants: [],
  });
  expect((await authorize()).allowed).toBe(false);
  const permissive = [
    {
      scope: model.id,
      grants: [
        {
          subject: { type: "organization" as const, id: "*" as const },
          actions: ["use" as const],
        },
      ],
      legacyOrganizationAudience: false,
    },
  ];
  for (const snapshot of [
    { organizationId: foreign.id, modelId: model.id, policies: permissive },
    {
      organizationId: org.id,
      modelId: crypto.randomUUID(),
      policies: permissive,
    },
  ]) {
    expect(
      (
        await checkModelTeamAccess({
          ...params,
          authenticatedUserId: user.id,
          policySnapshot: snapshot,
        })
      ).allowed,
    ).toBe(false);
  }
  // Restricted grants still use the full current principal rather than the
  // organization shortcut; explicit user grants and their removal take effect.
  const revoked = await ResourcePermissionPolicyModel.find(policyKey);
  await ResourcePermissionPolicyModel.replace({
    ...policyKey,
    revision: revoked?.revision ?? 0,
    grants: [
      { subject: { type: "user", id: user.id }, actions: ["read", "use"] },
    ],
  });
  expect(await authorize()).toEqual({ allowed: true });
  expect((await authorize(null)).allowed).toBe(false);
  await db
    .delete(schema.resourcePermissionPoliciesTable)
    .where(eq(schema.resourcePermissionPoliciesTable.organizationId, org.id));
  expect((await authorize()).allowed).toBe(false);
});
