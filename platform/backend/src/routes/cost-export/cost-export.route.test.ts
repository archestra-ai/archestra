import { type Action, ADMIN_ROLE_NAME, type Resource } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { S3Client } from "@aws-sdk/client-s3";
import { vi } from "vitest";
import { userHasPermission } from "@/auth/utils";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import blobProviderRoutes from "@/routes/blob-provider/blob-provider.routes";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { FakeS3Client } from "@/test/fake-s3-client";
import { ApiError, type User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import costExportRoutes from "./cost-export.routes";

describe("cost export routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let blobProviderId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = await buildApp(
      () => user,
      () => organizationId,
    );
    // The network is the boundary: every S3 call lands in an in-memory bucket.
    const s3 = new FakeS3Client();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(((
      command: unknown,
    ) => s3.send(command)) as never);
    const provider = await app.inject({
      method: "POST",
      url: "/api/blob-providers",
      payload: {
        name: "finops",
        config: {
          type: "s3",
          bucket: "finops",
          region: "us-east-1",
          keyPrefix: "",
          authMethod: "default_chain",
        },
      },
    });
    blobProviderId = provider.json().id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("a cost export manager runs the whole lifecycle without organization settings access", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: {
        costExport: ["read", "create", "update", "delete"],
        llmCost: ["read"],
      },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });

    const created = await create();
    const id = created.json().id;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/cost-exports/${id}`,
      payload: { enabled: false },
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/cost-exports/${id}/run`,
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/cost-exports",
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/cost-exports/${id}`,
    });

    expect(created.statusCode).toBe(200);
    expect(updated.statusCode).toBe(200);
    expect(run.statusCode).toBe(202);
    expect(listed.json().map((e: { id: string }) => e.id)).toEqual([id]);
    expect(deleted.statusCode).toBe(200);
  });

  test("scheduling an export also needs cost visibility", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    // Without llmCost:read the export would ship spend its holder can't see.
    const role = await makeCustomRole(organizationId, {
      permission: { costExport: ["read", "create", "update", "delete"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });

    const created = await create();
    const listed = await app.inject({
      method: "GET",
      url: "/api/cost-exports",
    });

    expect(created.statusCode).toBe(403);
    expect(listed.statusCode).toBe(200);
  });

  test("organization settings access alone no longer manages exports", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: {
        organizationSettings: ["read", "update"],
        llmCost: ["read"],
      },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });

    const listed = await app.inject({
      method: "GET",
      url: "/api/cost-exports",
    });
    const created = await create();

    expect(listed.statusCode).toBe(403);
    expect(created.statusCode).toBe(403);
  });

  test("scheduling an export is audited", async () => {
    const created = await create();
    await drainBackgroundWork();

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: created.json().id,
      action: "costExport.created" as never,
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].after).toMatchObject({ name: "daily", schedule: "daily" });
  });

  // ===== Helpers =====

  function create() {
    return app.inject({
      method: "POST",
      url: "/api/cost-exports",
      payload: {
        name: "daily",
        blobProviderId,
        format: "focus_csv",
        schedule: "daily",
        pathPrefix: "costs",
      },
    });
  }
});

/** Real DB-backed RBAC from the endpoint permission map, plus the audit hook. */
async function buildApp(
  getUser: () => User,
  getOrganizationId: () => string,
): Promise<FastifyInstanceWithZod> {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    const user = getUser();
    const organizationId = getOrganizationId();
    Object.assign(request, { user, organizationId });
    const routeId = request.routeOptions.schema?.operationId;
    const required = routeId
      ? requiredEndpointPermissionsMap[
          routeId as keyof typeof requiredEndpointPermissionsMap
        ]
      : undefined;
    for (const [resource, actions] of Object.entries(required ?? {})) {
      for (const action of (actions ?? []) as Action[]) {
        if (
          !(await userHasPermission(
            user.id,
            organizationId,
            resource as Resource,
            action,
          ))
        ) {
          throw new ApiError(403, "Forbidden");
        }
      }
    }
  });
  registerAuditLogHook(app);
  await app.register(blobProviderRoutes);
  await app.register(costExportRoutes);
  return app;
}
