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
      message:
        "AccessDenied: the identity can't write to s3://finops/archestra/. It needs s3:PutObject and s3:DeleteObject on arn:aws:s3:::finops/archestra/*.",
    });
  });

  test("a create whose connection test fails is rejected with the provider's error and saves nothing", async () => {
    s3.send = async () => {
      throw Object.assign(new Error("The specified bucket does not exist"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      });
    };

    const response = await create({
      name: "missing-bucket",
      config: s3Config({ authMethod: "default_chain" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      message: 'Bucket "finops" does not exist in us-east-1.',
      internal_code: "blob_provider_connection_failed",
    });
    expect(
      await BlobProviderModel.findByName({
        organizationId,
        name: "missing-bucket",
      }),
    ).toBeNull();
  });

  test("skipConnectionTest saves a configuration that can't connect yet", async () => {
    s3.send = async () => {
      throw Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    };

    const response = await create({
      name: "later",
      config: s3Config({ authMethod: "default_chain" }),
      skipConnectionTest: true,
    });

    expect(response.statusCode).toBe(200);
  });

  test("an edit is tested with the stored credentials when none are sent", async () => {
    const { id } = (
      await create({
        name: "rename-me",
        config: s3Config({ authMethod: "access_key" }),
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "shh" },
      })
    ).json();
    let usedKey: string | undefined;
    const send = s3.send.bind(s3);
    vi.mocked(S3Client.prototype.send).mockImplementation(async function (
      this: S3Client,
      command: unknown,
    ) {
      usedKey = (await this.config.credentials()).accessKeyId;
      return send(command);
    } as never);

    const response = await app.inject({
      method: "PUT",
      url: `/api/blob-providers/${id}`,
      payload: {
        config: {
          ...s3Config({ authMethod: "access_key" }),
          region: "eu-west-1",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(usedKey).toBe("AKIAEXAMPLE");
    expect(response.json().hasCredentials).toBe(true);
  });

  test("Azure credentials must match the auth method", async () => {
    const response = await create({
      name: "azure",
      config: {
        type: "azure_blob",
        accountName: "finopsexports",
        container: "cost-exports",
        authMethod: "sas_token",
      },
      credentials: { accountKey: "not-a-sas-token" },
      skipConnectionTest: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("SAS token is required");
  });

  test("a GCS service account key must be a service account JSON key", async () => {
    const response = await create({
      name: "gcs",
      config: {
        type: "gcs",
        bucket: "finops-exports",
        authMethod: "service_account_key",
      },
      credentials: { serviceAccountKey: '{"type":"authorized_user"}' },
      skipConnectionTest: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/service account JSON key/);
  });

  test("a provider a cost export writes to lists that export and cannot be deleted", async () => {
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

    const listed = await app.inject({
      method: "GET",
      url: "/api/blob-providers",
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/blob-providers/${id}`,
    });

    expect(listed.json()[0].usedBy).toEqual({ costExports: ["daily"] });
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

  test("whoever schedules cost exports can list destinations, but not change them", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    await create({
      name: "finops",
      config: s3Config({ authMethod: "default_chain" }),
    });
    const role = await makeCustomRole(organizationId, {
      permission: { costExport: ["read", "create"], llmCost: ["read"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });

    const listed = await app.inject({
      method: "GET",
      url: "/api/blob-providers",
    });
    const created = await create({
      name: "nope",
      config: s3Config({ authMethod: "default_chain" }),
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((p: { name: string }) => p.name)).toEqual([
      "finops",
    ]);
    expect(created.statusCode).toBe(403);
  });

  test("members without either permission cannot list destinations", async ({
    makeUser,
    makeMember,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });

    const listed = await app.inject({
      method: "GET",
      url: "/api/blob-providers",
    });

    expect(listed.statusCode).toBe(403);
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
