import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import KbChunkModel from "@/models/kb-chunk";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createEnvironment } from "@/services/environments/environment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createRestrictedEnvironment } from "@/test/environments";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import knowledgeBaseRoutes from "../knowledge-base";
import knowledgeFileRoutes from "./knowledge-file.routes";

describe("uploaded files connector environment", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(knowledgeBaseRoutes);
    await app.register(knowledgeFileRoutes);
  });
  afterEach(async () => app.close());

  async function uploadAndIndex() {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: {
        filename: "policy.txt",
        mimeType: "text/plain",
        content: Buffer.from(
          "The quokka retention policy is seven days.",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const indexed = await app.inject({
      method: "POST",
      url: "/api/knowledge-files/index",
      payload: {
        fileIds: [upload.json().id],
        newKnowledgeBaseName: "Policies",
      },
    });
    expect(indexed.statusCode, indexed.body).toBe(200);
    expect(indexed.json()).toMatchObject({ indexed: 1, failures: [] });
    return indexed;
  }

  test("lets the knowledge base load its uploaded files settings and move retrieval to one environment", async () => {
    const environment = await createEnvironment({
      organizationId,
      userId: user.id,
      data: { name: "Support" },
    });
    const otherEnvironment = await createEnvironment({
      organizationId,
      userId: user.id,
      data: { name: "Engineering" },
    });
    const indexed = await uploadAndIndex();
    const connectors = await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId,
      canReadAll: true,
    });
    expect(connectors).toHaveLength(1);
    const connector = connectors[0];
    const search = (
      environmentId: string | null,
      userAcl = [`principal:${user.id}`, `user_email:${user.email}`],
    ) =>
      KbChunkModel.fullTextSearch({
        connectorIds: [connector.id],
        queryText: "quokka",
        userAcl,
        environmentId,
      });
    expect(await search(null)).toHaveLength(1);
    expect(await search(environment.id)).toHaveLength(0);

    const knowledgeBaseId = indexed.json().knowledgeBaseId;
    const listed = await app.inject({
      method: "GET",
      url: "/api/knowledge-bases",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toEqual([
      expect.objectContaining({
        id: knowledgeBaseId,
        uploadedFilesEnvironmentId: null,
      }),
    ]);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/knowledge-bases/${knowledgeBaseId}`,
      payload: { uploadedFilesEnvironmentId: environment.id },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().uploadedFilesEnvironmentId).toBe(environment.id);
    const reloaded = await app.inject({
      method: "GET",
      url: `/api/knowledge-bases/${knowledgeBaseId}`,
    });
    expect(reloaded.json().uploadedFilesEnvironmentId).toBe(environment.id);
    expect(
      (await KnowledgeBaseConnectorModel.findById(connector.id))?.environmentId,
    ).toBe(environment.id);
    expect(await search(environment.id)).toHaveLength(1);
    expect(await search(null)).toHaveLength(0);
    expect(await search(otherEnvironment.id)).toHaveLength(0);
    expect(
      await search(environment.id, ["user_email:other@example.com"]),
    ).toHaveLength(0);

    await drainBackgroundWork();
    const audits = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: knowledgeBaseId,
      action: "knowledgeBase.updated",
      limit: 10,
      offset: 0,
    });
    expect(audits.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: expect.objectContaining({ uploadedFilesEnvironmentId: null }),
          after: expect.objectContaining({
            uploadedFilesEnvironmentId: environment.id,
          }),
        }),
      ]),
    );
  });
  test("rejects restricted and foreign environments before changing the knowledge base", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const indexed = await uploadAndIndex();
    const id = indexed.json().knowledgeBaseId;
    const restricted = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Restricted" },
    });
    const foreign = await createEnvironment({
      organizationId: (await makeOrganization()).id,
      data: { name: "Foreign" },
    });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "knowledgeBase",
      scope: id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "knowledgeBase",
      scope: id,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        {
          subject: { type: "user", id: editor.id },
          actions: ["read", "update"],
        },
      ],
    });
    user = editor;
    for (const environmentId of [restricted.id, foreign.id]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/knowledge-bases/${id}`,
        payload: { name: "Changed", uploadedFilesEnvironmentId: environmentId },
      });
      expect([400, 403, 404]).toContain(response.statusCode);
      expect((await KnowledgeBaseModel.findById(id))?.name).toBe("Policies");
      expect(await KnowledgeBaseModel.findUploadedFilesEnvironment(id)).toEqual(
        { uploadedFilesEnvironmentId: null },
      );
    }
  });

  test("requires update access to the knowledge base even when its uploaded files are readable", async ({
    makeUser,
    makeMember,
  }) => {
    const indexed = await uploadAndIndex();
    const id = indexed.json().knowledgeBaseId;
    const reader = await makeUser();
    await makeMember(reader.id, organizationId);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "knowledgeBase",
      scope: id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "knowledgeBase",
      scope: id,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        { subject: { type: "user", id: reader.id }, actions: ["read", "use"] },
      ],
    });
    user = reader;
    const response = await app.inject({
      method: "PUT",
      url: `/api/knowledge-bases/${id}`,
      payload: { uploadedFilesEnvironmentId: null },
    });
    expect(response.statusCode).toBe(403);
  });

  test("does not create or alter a source connector when the base has no uploaded files", async ({
    makeKnowledgeBase,
  }) => {
    const kb = await makeKnowledgeBase(organizationId, {
      name: "Empty",
      createdBy: user.id,
      access: { users: [user.id], preset: "manage" },
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/knowledge-bases/${kb.id}`,
      payload: { name: "Changed", uploadedFilesEnvironmentId: null },
    });
    expect(response.statusCode).toBe(404);
    expect((await KnowledgeBaseModel.findById(kb.id))?.name).toBe("Empty");
  });
});
