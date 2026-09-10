// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import ModelModel from "@/models/model";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import modelRoutes from "./llm-provider-models";

describe("scoped model grants", () => {
  const ctx = useRouteTestApp(modelRoutes);
  beforeEach(async ({ makeMember, makeCustomRole }) => {
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    registerAuditLogHook(ctx.app);
  });

  test("an exact editor can change pricing but cannot change another model or its recipients", async ({
    makeTeam,
  }) => {
    const model = await createModel("scoped-model");
    const other = await createModel("other-model");
    const key = {
      organizationId: ctx.organizationId,
      resource: "llmModel" as const,
      scope: model.id,
    };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [
        {
          subject: { type: "user", id: ctx.user.id },
          actions: ["read", "update"],
        },
      ],
    });
    const changed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/llm-models/${model.id}`,
      payload: {
        customPricePerMillionInput: "2.5",
        customPricePerMillionOutput: "5",
        teamIds: [],
        userIds: [],
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      Number((await ModelModel.findById(model.id))?.customPricePerMillionInput),
    ).toBe(2.5);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceId: model.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            pricePerMillionInput: "2.50",
          }),
        }),
      ]),
    );
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/llm-models/${other.id}`,
          payload: { ignored: true },
        })
      ).statusCode,
    ).toBe(403);
    const bulk = await ctx.app.inject({
      method: "PATCH",
      url: "/api/llm-models/bulk",
      payload: { ids: [model.id, other.id], ignored: true },
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(
      bulk.json().succeeded.map((entry: { id: string }) => entry.id),
    ).toEqual([model.id]);
    expect(bulk.json().failed.map((entry: { id: string }) => entry.id)).toEqual(
      [other.id],
    );
    expect((await ModelModel.findById(other.id))?.ignored).toBe(false);
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/llm-models/${model.id}`,
          payload: { teamIds: [team.id] },
        })
      ).statusCode,
    ).toBe(400);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [],
    });
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/llm-models/${model.id}`,
          payload: { ignored: true },
        })
      ).statusCode,
    ).toBe(403);
  });
});

function createModel(modelId: string) {
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    description: modelId,
    contextLength: 200000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    promptPricePerToken: "0.000003",
    completionPricePerToken: "0.000015",
    ignored: false,
    lastSyncedAt: new Date(),
  });
}
