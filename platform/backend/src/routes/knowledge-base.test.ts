import { KnowledgeBaseConnectorModel, KnowledgeBaseModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("knowledge base routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("connector routes reflect that deleting a knowledge base removes its assignments without deleting the connector", async () => {
    const knowledgeBase = await KnowledgeBaseModel.create({
      organizationId,
      name: "Route Test KB",
    });
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "Route Test Connector",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://test.atlassian.net",
        isCloud: true,
        projectKey: "PROJ",
      },
    });
    await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
      connector.id,
      knowledgeBase.id,
    );

    const beforeDeleteResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}/knowledge-bases`,
    });

    expect(beforeDeleteResponse.statusCode).toBe(200);
    expect(beforeDeleteResponse.json()).toEqual({
      data: [
        expect.objectContaining({
          id: knowledgeBase.id,
          name: "Route Test KB",
        }),
      ],
    });

    await KnowledgeBaseModel.delete(knowledgeBase.id);
    expect(await KnowledgeBaseModel.findById(knowledgeBase.id)).toBeNull();

    const connectorResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}`,
    });

    expect(connectorResponse.statusCode).toBe(200);
    expect(connectorResponse.json()).toMatchObject({
      id: connector.id,
      name: "Route Test Connector",
    });

    const connectorKnowledgeBasesResponse = await app.inject({
      method: "GET",
      url: `/api/connectors/${connector.id}/knowledge-bases`,
    });

    expect(connectorKnowledgeBasesResponse.statusCode).toBe(200);
    expect(connectorKnowledgeBasesResponse.json()).toEqual({ data: [] });
  });
});
