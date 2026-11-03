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
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
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
    expect((await remove(model.id, manager.id)).statusCode).toBe(200);
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
    expect((await remove(model.id)).statusCode).toBe(
      status === "pending" || status === "running" ? 409 : 200,
    );
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
    promptPricePerToken: "0",
    completionPricePerToken: "0",
    discoveredViaLlmProxy: true,
    lastSyncedAt: new Date(),
  });
}
