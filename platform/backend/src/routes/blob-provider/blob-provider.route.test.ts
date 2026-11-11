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
import BlobProviderModel from "@/models/blob-provider";
import { secretManager } from "@/secrets-manager";
import { costExportService } from "@/services/cost-export";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { FakeS3Client } from "@/test/fake-s3-client";
import { ApiError, type User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import blobProviderRoutes from "./blob-provider.routes";

describe("blob provider routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let s3: FakeS3Client;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = await buildApp(
      () => user,
      () => organizationId,
    );
    // The network is the boundary: every S3 call lands in an in-memory bucket.
    s3 = new FakeS3Client();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(((
      command: unknown,
    ) => s3.send(command)) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("stores access keys write-only and never returns them", async () => {
    const created = await create({
      name: "finops-bucket",
      config: s3Config({ authMethod: "access_key" }),
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "shh" },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body).toMatchObject({
      name: "finops-bucket",
      type: "s3",
      hasCredentials: true,
      config: {
        bucket: "finops",
        keyPrefix: "archestra",
        authMethod: "access_key",
      },
    });
    expect(JSON.stringify(body)).not.toContain("shh");

    const listed = await app.inject({
      method: "GET",
      url: "/api/blob-providers",
    });
    expect(JSON.stringify(listed.json())).not.toContain("shh");

    const row = await BlobProviderModel.findById({
      id: body.id,
      organizationId,
    });
    const secret = await secretManager().getSecret(row?.secretId ?? "");
    expect(secret?.secret).toMatchObject({ secretAccessKey: "shh" });

    await drainBackgroundWork();
    const audit = await auditRecords(body.id, "blobProvider.created");
    expect(audit.after).toMatchObject({
      name: "finops-bucket",
      hasCredentials: true,
    });
    expect(JSON.stringify(audit)).not.toContain("shh");
  });

  test("rejects the access key method without credentials", async () => {
    const response = await create({
      name: "missing-keys",
      config: s3Config({ authMethod: "access_key" }),
    });
    expect(response.statusCode).toBe(400);
  });

  test("switching to the default chain drops stored credentials", async () => {
    const { id } = (
      await create({
        name: "switching",
        config: s3Config({ authMethod: "access_key" }),
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "shh" },
      })
    ).json();
    const before = await BlobProviderModel.findById({ id, organizationId });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/blob-providers/${id}`,
      payload: { config: s3Config({ authMethod: "default_chain" }) },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().hasCredentials).toBe(false);
    expect(await secretManager().getSecret(before?.secretId ?? "")).toBeNull();
  });

  test("a connection test writes and removes a probe object under the prefix", async () => {
    const { id } = (
      await create({
        name: "probe",
        config: s3Config({ authMethod: "default_chain" }),
      })
    ).json();
    const putKeys: string[] = [];
    const send = s3.send.bind(s3);
    s3.send = async (command: unknown) => {
      const input = (command as { input?: { Key?: string } }).input;
      if (command?.constructor?.name === "PutObjectCommand" && input?.Key) {
        putKeys.push(input.Key);
      }
      return send(command);
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/blob-providers/${id}/test`,
    });

    expect(response.json()).toEqual({
      success: true,
      message: "Wrote and deleted a test object.",
    });
    expect(putKeys).toHaveLength(1);
    expect(putKeys[0]).toMatch(/^archestra\/\.archestra-connection-test\//);
    expect(s3.keys()).toEqual([]);
  });

  test("a failed connection test reports the provider's error", async () => {
    const { id } = (
      await create({
        name: "denied",
        config: s3Config({ authMethod: "default_chain" }),
      })
    ).json();
    s3.send = async () => {
      throw Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/blob-providers/${id}/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: false,
      message: "AccessDenied, HTTP 403: Access Denied",
    });
  });

  test("a provider a cost export writes to cannot be deleted", async () => {
    const { id } = (
      await create({
        name: "in-use",
        config: s3Config({ authMethod: "default_chain" }),
      })
    ).json();
    await costExportService.create({
      organizationId,
      data: {
        name: "daily",
        blobProviderId: id,
        format: "focus_csv",
        schedule: "daily",
        pathPrefix: "costs",
        enabled: true,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/blob-providers/${id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(
      await BlobProviderModel.findById({ id, organizationId }),
    ).not.toBeNull();
  });

  test("another organization's provider is not found", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const foreign = await BlobProviderModel.create({
      organizationId: other.id,
      name: "foreign",
      config: {
        type: "s3",
        bucket: "b",
        region: "us-east-1",
        keyPrefix: "",
        endpoint: null,
        forcePathStyle: false,
        authMethod: "default_chain",
        roleArn: null,
        externalId: null,
      },
      secretId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/blob-providers/${foreign.id}/test`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("members without organization settings access are refused", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const response = await create({
      name: "nope",
      config: s3Config({ authMethod: "default_chain" }),
    });

    expect(response.statusCode).toBe(403);
  });

  // ===== Helpers =====

  function create(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/blob-providers", payload });
  }

  async function auditRecords(resourceId: string, action: string) {
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceId,
      action: action as never,
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    return data[0];
  }
});

function s3Config(overrides: { authMethod: string }) {
  return {
    type: "s3",
    bucket: "finops",
    region: "us-east-1",
    keyPrefix: "/archestra/",
    ...overrides,
  };
}

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
  return app;
}
