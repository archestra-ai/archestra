// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { AddressInfo } from "node:net";
import { http, passthrough } from "msw";
import { executeArchestraTool } from "@/archestra-mcp-server";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import EnvironmentResourceDefaultModel from "@/models/environment-resource-default";
import KbChunkModel from "@/models/kb-chunk";
import KbDocumentModel from "@/models/kb-document";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import { createEnvironment } from "@/services/environments/environment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { createRestrictedEnvironment } from "@/test/environments";
import {
  configureKnowledgeSearch,
  knowledgeEmbeddingHandler,
} from "@/test/knowledge-search";
import { useMswServer } from "@/test/msw";
import type { Agent, User } from "@/types";
import knowledgeBaseRoutes from "../knowledge-base";
import knowledgeFileRoutes from "./knowledge-file.routes";

const content = "The quokka retention policy is seven days.";

describe("uploaded files landing environment over HTTP", () => {
  const network = useMswServer(knowledgeEmbeddingHandler);
  let app: FastifyInstanceWithZod;
  let appUrl: string;
  let organizationId: string;
  let user: User;
  let roleName: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeLlmProviderApiKey,
      makeCustomRole,
    }) => {
      organizationId = (await makeOrganization()).id;
      user = await makeUser();
      roleName = (
        await makeCustomRole(organizationId, {
          permission: {
            knowledgeSource: ["create", "read", "update", "query"],
          },
        })
      ).role;
      await makeMember(user.id, organizationId, { role: roleName });
      await configureKnowledgeSearch(organizationId, makeLlmProviderApiKey);
      app = await authenticatedRouteApp({
        organizationId,
        routes: [knowledgeFileRoutes, knowledgeBaseRoutes],
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      appUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      network.use(
        http.post(`${appUrl}/api/knowledge-files`, () => passthrough()),
        http.post(`${appUrl}/api/knowledge-files/index`, () => passthrough()),
      );
    },
  );

  afterEach(async () => {
    await app?.close();
  });

  async function request(path: string, body: object, method = "POST") {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", [USER_HEADER]: user.id },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  }

  async function uploadAndIndex(knowledgeBaseId: string) {
    const file = await request("/api/knowledge-files", {
      filename: `${crypto.randomUUID()}.txt`,
      mimeType: "text/plain",
      content: Buffer.from(content).toString("base64"),
    });
    const result = await request("/api/knowledge-files/index", {
      fileIds: [file.id],
      knowledgeBaseId,
    });
    expect(result).toMatchObject({ indexed: 1, failures: [] });
    const connectors = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
      knowledgeBaseId,
      { canReadAll: true },
    );
    const connector = connectors.find(
      (candidate) => candidate.connectorType === "file_upload",
    );
    if (!connector) throw new Error("Expected upload connector");
    const document = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: file.id,
    });
    if (!document) throw new Error("Expected uploaded document");
    const chunks = await KbChunkModel.findByDocument(document.id);
    // Synthetic embedding boundary; actual retrieval SQL and document ACLs stay real.
    const embedding = Array.from({ length: 1536 }, () => 0.01);
    await KbChunkModel.updateEmbeddings(
      chunks.map((chunk) => ({ chunkId: chunk.id, embedding })),
      embedding.length,
    );
    return { connector, document };
  }

  const query = (agent: Agent, userId = user.id) =>
    executeArchestraTool(
      "archestra__query_knowledge_sources",
      { query: "quokka retention" },
      { organizationId, userId, agent: { id: agent.id, name: agent.name } },
    );

  test("new upload follows the landing environment without widening source access", async ({
    makeKnowledgeBase,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const support = await createEnvironment({
      organizationId,
      userId: user.id,
      data: { name: "Support" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "knowledgeSource",
      environmentId: support.id,
    });
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId, { role: roleName });
    const kb = await makeKnowledgeBase(organizationId, {
      access: { users: [user.id], preset: "manage" },
    });
    const { connector, document } = await uploadAndIndex(kb.id);
    const agents = await Promise.all(
      [support.id, null].map((environmentId) =>
        makeAgent({
          organizationId,
          environmentId,
          knowledgeBaseIds: [kb.id],
          accessAllTools: false,
        }),
      ),
    );
    const found = await query(agents[0]);
    expect(found.isError, JSON.stringify(found)).toBe(false);
    expect(connector.environmentId).toBe(support.id);
    expect(document.acl).toEqual([`user_email:${user.email}`]);
    expect(JSON.stringify(found)).toContain(document.id);
    expect(JSON.stringify(found)).toContain(content);
    const wrongEnvironment = await query(agents[1]);
    expect(wrongEnvironment.isError).toBe(true);
    expect(JSON.stringify(wrongEnvironment)).not.toContain(document.id);
    const privateResult = await query(agents[0], colleague.id);
    expect(JSON.stringify(privateResult)).not.toContain(document.id);
    expect(JSON.stringify(privateResult)).not.toContain(content);
  });

  for (const mode of [
    "unset",
    "not-permitted",
    "other-organization",
  ] as const) {
    test(`falls back to Default when landing is ${mode}`, async ({
      makeKnowledgeBase,
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      if (mode !== "unset") {
        const owner = await makeUser();
        const envOrg =
          mode === "other-organization"
            ? (await makeOrganization()).id
            : organizationId;
        const environment = await createRestrictedEnvironment({
          organizationId: envOrg,
          userId: owner.id,
          data: { name: "Restricted" },
        });
        await EnvironmentResourceDefaultModel.setForResource({
          organizationId,
          resource: "knowledgeSource",
          environmentId: environment.id,
        });
      }
      const kb = await makeKnowledgeBase(organizationId, {
        access: { users: [user.id], preset: "manage" },
      });
      const { connector, document } = await uploadAndIndex(kb.id);
      expect(connector.environmentId).toBeNull();
      const agent = await makeAgent({
        organizationId,
        environmentId: null,
        knowledgeBaseIds: [kb.id],
        accessAllTools: false,
      });
      const found = await query(agent);
      expect(found.isError).toBe(false);
      expect(JSON.stringify(found)).toContain(document.id);
    });
  }

  test("later uploads retain an explicitly selected connector environment after the landing default changes", async ({
    makeKnowledgeBase,
  }) => {
    const support = await createEnvironment({
      organizationId,
      userId: user.id,
      data: { name: "Support" },
    });
    const engineering = await createEnvironment({
      organizationId,
      userId: user.id,
      data: { name: "Engineering" },
    });
    const kb = await makeKnowledgeBase(organizationId, {
      access: { users: [user.id], preset: "manage" },
    });
    const first = await uploadAndIndex(kb.id);
    network.use(
      http.put(`${appUrl}/api/knowledge-bases/${kb.id}`, () => passthrough()),
    );
    await request(
      `/api/knowledge-bases/${kb.id}`,
      { uploadedFilesEnvironmentId: support.id },
      "PUT",
    );
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "knowledgeSource",
      environmentId: engineering.id,
    });
    const second = await uploadAndIndex(kb.id);
    expect(second.connector.id).toBe(first.connector.id);
    expect(second.connector.environmentId).toBe(support.id);
    if (!first.document.sourceId)
      throw new Error("Expected uploaded file source");
    const persisted = await KbDocumentModel.findBySourceId({
      connectorId: first.connector.id,
      sourceId: first.document.sourceId,
    });
    expect(persisted?.id).toBe(first.document.id);
  });
});
