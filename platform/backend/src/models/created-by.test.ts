import { beforeEach, describe, expect, test } from "@/test";
import A2aRemoteAgentModel from "./a2a-remote-agent";
import AgentModel from "./agent";
import CreatedByModel from "./created-by";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import KbFileModel from "./kb-file";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";
import LlmOauthClientModel from "./llm-oauth-client";
import McpOauthClientModel from "./mcp-oauth-client";
import McpServerModel from "./mcp-server";
import RuntimeCredentialDefinitionModel from "./runtime-credential-definition";
import ServiceAccountModel from "./service-account";
import TeamModel from "./team";

let organizationId: string;
let serviceAccountId: string;
let actorId: string;

beforeEach(async ({ makeOrganization }) => {
  const organization = await makeOrganization();
  organizationId = organization.id;
  const account = await ServiceAccountModel.create({
    organizationId,
    name: "Release automation",
    role: "admin",
    createdBy: null,
  });
  serviceAccountId = account.id;
  actorId = `service-account:${account.id}`;
});

const expectedCreator = () => ({
  id: actorId,
  name: "Release automation",
  email: null,
  type: "service_account",
});

describe("service-account authorship across resource models", () => {
  test("attributes shared MCP installations without creating a personal user assignment", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "Shared automation tools",
        serverType: "remote",
        serverUrl: "https://tools.example.invalid/mcp",
        scope: "org",
      },
      { organizationId, authorId: actorId },
    );
    const server = await McpServerModel.create({
      catalogId: catalog.id,
      name: "Automation installation",
      serverType: "remote",
      scope: "org",
      userId: actorId,
    });
    expect(server.ownerId).toBeNull();
    expect(
      await CreatedByModel.resolveOne(
        CreatedByModel.id(server, server.ownerId),
      ),
    ).toEqual(expectedCreator());
  });
  test("keeps a knowledge file's uploader without inserting a synthetic user", async () => {
    const file = await KbFileModel.create({
      organizationId,
      directoryId: null,
      filename: "release.md",
      mimeType: "text/markdown",
      sizeBytes: 5,
      contentHash: "abc",
      data: Buffer.from("notes"),
      visibility: "org-wide",
      teamIds: [],
      uploadedBy: actorId,
    });
    expect(file.uploadedBy).toBeNull();
    expect(
      await CreatedByModel.resolveOne(CreatedByModel.id(file, file.uploadedBy)),
    ).toEqual(expectedCreator());
  });

  test("attributes a knowledge connector", async () => {
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "Issue knowledge",
      createdBy: actorId,
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://issues.example.invalid",
        isCloud: true,
        projectKey: "ENG",
      },
    });
    expect(connector.createdBy).toBeNull();
    expect(
      await CreatedByModel.resolveOne(
        CreatedByModel.id(connector, connector.createdBy),
      ),
    ).toEqual(expectedCreator());
  });

  test("attributes a runtime credential definition", async () => {
    const definition = await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: actorId,
      definition: {
        icon: null,
        key: "release-token",
        name: "Release token",
        description: "Release automation connection",
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    expect(definition.createdBy).toBeNull();
    expect(
      await CreatedByModel.resolveOne(
        CreatedByModel.id(definition, definition.createdBy),
      ),
    ).toEqual(expectedCreator());
  });

  test("creates a team without making its service-account creator a human member", async () => {
    const team = await TeamModel.create({
      organizationId,
      name: "Release engineering",
      createdBy: actorId,
    });
    expect(team.createdBy).toBeNull();
    expect(team.members).toEqual([]);
    expect(
      await CreatedByModel.resolveOne(CreatedByModel.id(team, team.createdBy)),
    ).toEqual(expectedCreator());
  });

  test("attributes an external agent", async () => {
    const agent = await A2aRemoteAgentModel.create({
      organizationId,
      name: "Release specialist",
      authorId: actorId,
      scope: "org",
      discoveryMode: "inline_card",
      agentCard: { name: "Release specialist" },
      cardHash: "abc",
    });
    expect(agent.authorId).toBeNull();
    expect(
      await CreatedByModel.resolveOne(CreatedByModel.id(agent, agent.authorId)),
    ).toEqual(expectedCreator());
  });

  test.each([
    LlmOauthClientModel,
    McpOauthClientModel,
  ])("preserves OAuth-client creator metadata", async (Model) => {
    const client = await Model.create({
      organizationId,
      name: "Automation client",
      authorId: actorId,
      scope: "org",
    });
    expect(client.oauthClient.createdBy).toEqual(expectedCreator());
  });

  test("resolves mixed human and service-account creators in a single batch", async ({
    makeUser,
  }) => {
    const human = await makeUser();
    const creators = await CreatedByModel.resolve([
      actorId,
      human.id,
      actorId,
      null,
      "deleted-user",
    ]);
    expect(creators.size).toBe(2);
    expect(creators.get(actorId)).toEqual(expectedCreator());
    expect(creators.get(human.id)).toMatchObject({
      id: human.id,
      email: human.email,
    });
  });

  test("preserves an agent after deleting its service-account creator", async () => {
    const agent = await AgentModel.create(
      {
        organizationId,
        name: "Automation agent",
        agentType: "agent",
        scope: "org",
      },
      actorId,
    );
    await ServiceAccountModel.delete(serviceAccountId, organizationId);
    const retained = await AgentModel.findById(agent.id);
    expect(retained).not.toBeNull();
    expect(retained?.createdByServiceAccountId).toBeNull();
    expect(retained?.createdBy).toBeNull();
  });

  test("rejects a foreign service-account principal before inserting", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    await expect(
      AgentModel.create(
        {
          organizationId: other.id,
          name: "Foreign creator",
          agentType: "agent",
          scope: "org",
        },
        actorId,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("rejects private file ownership for a service account", async () => {
    await expect(
      KbFileModel.create({
        organizationId,
        directoryId: null,
        filename: "private.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
        contentHash: "abc",
        data: Buffer.from("notes"),
        visibility: "private",
        teamIds: [],
        uploadedBy: actorId,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
