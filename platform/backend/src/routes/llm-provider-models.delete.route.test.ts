import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import ModelModel from "@/models/model";
import ModelCostBackfillModel from "@/models/model-cost-backfill";
import ModelPoolModel from "@/models/model-pool";
import OrganizationModel from "@/models/organization";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import RoutingDecisionModel from "@/models/routing-decision";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import routes from "./llm-provider-models";

describe("DELETE /api/llm-models/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    adminId = (await makeUser()).id;
    await makeMember(adminId, organizationId, { role: "admin" });
    app = await authenticatedRouteApp({
      organizationId,
      routes: [routes],
      auditLog: true,
    });
  });
  afterEach(async () => {
    await app.close();
  });
  const remove = (id: string, userId = adminId) =>
    app.inject({
      method: "DELETE",
      url: `/api/llm-models/${id}`,
      headers: { [USER_HEADER]: userId },
    });

  test("deletes metadata and policy, retains recorded spend, and audits the removal", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const model = await createModel();
    const agent = await makeAgent();
    const interaction = await makeInteraction(agent.id, {
      model: model.modelId,
      cost: "1.2500000000",
    });
    const policyKey = {
      organizationId,
      resource: "llmModel" as const,
      scope: model.id,
    };
    expect(await ResourcePermissionPolicyModel.find(policyKey)).not.toBeNull();
    const response = await remove(model.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await ModelModel.findById(model.id)).toBeNull();
    expect(await ResourcePermissionPolicyModel.find(policyKey)).toBeNull();
    expect(
      await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.id, interaction.id)),
    ).toEqual([interaction]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: model.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "llmModel.deleted",
          before: expect.objectContaining({ modelId: model.modelId }),
          after: null,
        }),
      ]),
    );
    expect((await remove(model.id)).statusCode).toBe(404);
    // This is cleanup, not a denylist: discovery can add it again.
    await ModelModel.ensureModelExists(model.modelId, model.provider);
    expect(
      await ModelModel.findByProviderAndModelId(model.provider, model.modelId),
    ).not.toBeNull();
  });

  test("refuses ordinary members and scoped editors; permits a global custom model manager", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const model = await createModel();
    const user = await makeUser();
    const role = await makeCustomRole(organizationId, { permission: {} });
    await makeMember(user.id, organizationId, { role: role.role });
    expect((await remove(model.id, user.id)).statusCode).toBe(403);
    const key = {
      organizationId,
      resource: "llmModel" as const,
      scope: model.id,
    };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "update"] },
      ],
    });
    expect((await remove(model.id, user.id)).statusCode).toBe(403);
    expect(await ModelModel.findById(model.id)).not.toBeNull();
    const manager = await makeUser();
    const managerRole = await makeCustomRole(organizationId, {
      permission: { llmModel: ["read", "update"] },
    });
    await makeMember(manager.id, organizationId, { role: managerRole.role });
    const cleanModel = await createModel("unconfigured-model");
    expect((await remove(cleanModel.id, manager.id)).statusCode).toBe(200);
  });

  test.for([
    "defaultModelId",
    "defaultFastModelId",
    "defaultSmartModelId",
  ] as const)("protects organization %s", async (field) => {
    const model = await createModel();
    await OrganizationModel.patch(organizationId, { [field]: model.id });
    const response = await remove(model.id);
    expect(response.statusCode, response.body).toBe(409);
    expect(await ModelModel.findById(model.id)).not.toBeNull();
  });

  test("protects agent, member and guardrails settings", async ({
    makeAgent,
  }) => {
    const model = await createModel();
    await makeAgent({ modelId: model.id });
    expect((await remove(model.id)).statusCode).toBe(409);
    const memberModel = await createModel("member-default");
    await db
      .update(schema.membersTable)
      .set({ defaultModelId: memberModel.id })
      .where(eq(schema.membersTable.userId, adminId));
    expect((await remove(memberModel.id)).statusCode).toBe(409);
    const guardrailModel = await createModel("guardrail-default");
    await GuardrailsDeploymentModel.set({
      annotatorModelId: guardrailModel.id,
    });
    expect((await remove(guardrailModel.id)).statusCode).toBe(409);
  });

  test.for([
    "embedding",
    "reranker",
    "ocr",
  ] as const)("protects the %s model by provider and name", async (kind, {
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const model = await createModel();
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: model.provider,
    });
    await OrganizationModel.patch(organizationId, {
      [`${kind}Model`]: model.modelId,
      [`${kind}ChatApiKeyId`]: key.id,
    });
    expect((await remove(model.id)).statusCode).toBe(409);
    const otherProvider = await createModel(model.modelId, "anthropic");
    expect((await remove(otherProvider.id)).statusCode).toBe(200);
  });

  for (const inTrash of [false, true]) {
    test(`preserves a chat model (in trash: ${inTrash})`, async ({
      makeAgent,
      makeConversation,
    }) => {
      const model = await createModel();
      const agent = await makeAgent();
      const conversation = await makeConversation(agent.id, {
        userId: adminId,
        organizationId,
        modelId: model.id,
      });
      if (inTrash) {
        await db
          .update(schema.conversationsTable)
          .set({ deletedAt: new Date() })
          .where(eq(schema.conversationsTable.id, conversation.id));
      }
      const response = await remove(model.id);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toContain("an existing chat");
      const [after] = await db
        .select()
        .from(schema.conversationsTable)
        .where(eq(schema.conversationsTable.id, conversation.id));
      expect(after.modelId).toBe(model.id);
      expect(await ModelModel.findById(model.id)).not.toBeNull();
    });
  }

  test("preserves session pins and routing history after a default tier changes", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const model = await createModel();
    await OrganizationModel.patch(organizationId, { defaultModelId: model.id });
    const sessionKey = RoutingSessionKeySchema.parse("cleanup-pinned-session");
    const { decision } = await RoutingDecisionModel.insertOrGet({
      organizationId,
      sessionKey,
      modelId: model.id,
      tierIndex: 1,
      propensity: 1,
      u: 0.5,
      reason: "cold_start",
      planId: null,
      features: null,
      featuresSchemaVersion: 1,
      coreVersion: "cleanup-test",
    });
    const replacement = await createModel("replacement-default");
    await OrganizationModel.patch(organizationId, {
      defaultModelId: replacement.id,
    });
    const agent = await makeAgent();
    const interaction = await makeInteraction(agent.id, {
      model: model.modelId,
      cost: "1.2500000000",
    });
    await db.insert(schema.routingUsageTable).values({
      interactionId: interaction.id,
      decisionId: decision.id,
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 5,
      estimated: false,
    });
    const historyKey = { organizationId, interactionId: interaction.id };
    const before = await RoutingDecisionModel.findForInteraction(historyKey);
    expect(before?.model.id).toBe(model.id);

    const response = await remove(model.id);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toContain("a routing decision");
    expect(await ModelModel.findById(model.id)).not.toBeNull();
    expect(
      await RoutingDecisionModel.find({ organizationId, sessionKey }),
    ).toEqual(decision);
    expect(await RoutingDecisionModel.findForInteraction(historyKey)).toEqual(
      before,
    );
    expect(
      await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.id, interaction.id)),
    ).toEqual([interaction]);
  });

  test.for([
    { discoveredViaLlmProxy: false },
    { promptPricePerToken: "0.000001" },
    { completionPricePerToken: "0" },
    { cacheReadPricePerToken: "0" },
    { cacheWritePricePerToken: "0.000001" },
    { customPricePerMillionInput: "0" },
    { customPricePerMillionOutput: "2" },
    { customPricePerMillionCacheRead: "0" },
    { customPricePerMillionCacheWrite: "3" },
    { customContextLength: 4096 },
    { customOutputLength: 1024 },
    { configuredParameters: { temperature: 0 } },
    { ignored: true },
    {
      longContextThreshold: 1000,
      longContextPricePerMillionInput: "1",
      longContextPricePerMillionOutput: "2",
      longContextPricePerMillionCacheRead: "0",
      longContextPricePerMillionCacheWrite: "0",
    },
  ])("retains configured model metadata: %j", async (settings) => {
    const model = await createModel();
    await db
      .update(schema.modelsTable)
      .set(settings)
      .where(eq(schema.modelsTable.id, model.id));
    const before = await ModelModel.findById(model.id);
    const response = await remove(model.id);
    expect(response.statusCode, response.body).toBe(409);
    expect(await ModelModel.findById(model.id)).toEqual(before);
  });

  test("retains provider links and their endpoint pricing", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const model = await createModel();
    const key = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret()).id,
      { provider: model.provider },
    );
    const [link] = await db
      .insert(schema.llmProviderApiKeyModelsTable)
      .values({
        apiKeyId: key.id,
        modelId: model.id,
        isBest: true,
        providerPricing: {
          promptPricePerToken: "0.000001",
          completionPricePerToken: "0.000002",
          cacheReadPricePerToken: null,
          cacheWritePricePerToken: null,
        },
      })
      .returning();
    expect((await remove(model.id)).statusCode).toBe(409);
    expect(
      await db
        .select()
        .from(schema.llmProviderApiKeyModelsTable)
        .where(eq(schema.llmProviderApiKeyModelsTable.id, link.id)),
    ).toEqual([link]);
    expect(await ModelModel.findById(model.id)).not.toBeNull();
  });

  test("retains labels and legacy sharing assignments", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminId);
    const [key] = await db
      .insert(schema.labelKeysTable)
      .values({ key: "cleanup-label" })
      .returning();
    const [value] = await db
      .insert(schema.labelValuesTable)
      .values({ value: "configured" })
      .returning();
    const labelled = await createModel("labelled");
    await db
      .insert(schema.modelLabelsTable)
      .values({ modelId: labelled.id, keyId: key.id, valueId: value.id });
    const teamShared = await createModel("team-shared");
    await db
      .insert(schema.modelTeamsTable)
      .values({ modelId: teamShared.id, teamId: team.id });
    const userShared = await createModel("user-shared");
    await db
      .insert(schema.modelUsersTable)
      .values({ modelId: userShared.id, userId: adminId });
    for (const model of [labelled, teamShared, userShared]) {
      expect((await remove(model.id)).statusCode).toBe(409);
      expect(await ModelModel.findById(model.id)).not.toBeNull();
    }
    expect(
      await db
        .select()
        .from(schema.modelLabelsTable)
        .where(eq(schema.modelLabelsTable.modelId, labelled.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.modelTeamsTable)
        .where(eq(schema.modelTeamsTable.modelId, teamShared.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.modelUsersTable)
        .where(eq(schema.modelUsersTable.modelId, userShared.id)),
    ).toHaveLength(1);
  });

  test("retains edited sharing policies across organizations", async ({
    makeOrganization,
  }) => {
    const model = await createModel();
    const otherOrganization = await makeOrganization();
    const key = {
      organizationId: otherOrganization.id,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const before = await ResourcePermissionPolicyModel.find(key);
    expect((await remove(model.id)).statusCode).toBe(409);
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(before);
    expect(await ModelModel.findById(model.id)).not.toBeNull();
  });

  test("protects pool members including disabled members without blocking another provider", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const model = await createModel();
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: model.provider,
    });
    await ModelPoolModel.create({
      organizationId,
      input: {
        name: "cleanup-pool",
        members: [
          {
            providerApiKeyId: key.id,
            modelId: model.modelId,
            priority: 1,
            weight: 1,
            enabled: false,
          },
        ],
      },
    });
    expect((await remove(model.id)).statusCode).toBe(409);
    const otherProvider = await createModel(model.modelId, "anthropic");
    expect((await remove(otherProvider.id)).statusCode).toBe(200);
  });

  test.for([
    "pending",
    "running",
    "completed",
    "failed",
  ] as const)("handles a %s cost backfill", async (status) => {
    const model = await createModel();
    const backfill = await ModelCostBackfillModel.create({
      organizationId,
      modelId: model.id,
      since: new Date(),
      cutoff: new Date(),
      rowsEstimated: 0,
      createdByUserId: adminId,
      pricing: {
        provider: model.provider,
        pricePerMillionInput: "1",
        pricePerMillionOutput: "2",
        pricePerMillionCacheRead: null,
        pricePerMillionCacheWrite: null,
        source: "custom",
        cacheSource: null,
      },
    });
    if (!backfill) throw new Error("Expected a backfill");
    await db
      .update(schema.modelCostBackfillsTable)
      .set({ status })
      .where(eq(schema.modelCostBackfillsTable.id, backfill.id));
    expect((await remove(model.id)).statusCode).toBe(409);
  });
});

function createModel(
  modelId = "cleanup-bogus-model",
  provider: "openai" | "anthropic" = "openai",
) {
  return ModelModel.create({
    externalId: `${provider}/${modelId}`,
    provider,
    modelId,
    description: modelId,
    contextLength: 4096,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    promptPricePerToken: null,
    completionPricePerToken: null,
    discoveredViaLlmProxy: true,
    lastSyncedAt: new Date(),
  });
}
