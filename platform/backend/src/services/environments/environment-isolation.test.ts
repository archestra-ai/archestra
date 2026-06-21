import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import EnvironmentModel from "@/models/environment";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import ToolModel from "@/models/tool";
import { expect, test } from "@/test";

/**
 * Environment isolation: an agent / MCP gateway in environment E may only
 * resolve and execute tools, and use knowledge connectors, that belong to E.
 * `null` = the org "Default" environment (a peer, matched by strict equality).
 * Built-in catalogs (Archestra, Playwright) are exempt.
 */

test("getMcpToolsByAgent: an agent in a named environment sees only that env's tools", async ({
  makeOrganization,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const dev = await EnvironmentModel.create({
    organizationId: org.id,
    name: "development",
  });

  const prodCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: prod.id,
  });
  const devCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: dev.id,
  });
  const defaultCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: null,
  });

  const prodTool = await makeTool({ catalogId: prodCatalog.id });
  const devTool = await makeTool({ catalogId: devCatalog.id });
  const defaultTool = await makeTool({ catalogId: defaultCatalog.id });

  // A prod agent with all three tools explicitly assigned (a misconfiguration
  // env isolation must still contain).
  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: prod.id,
  });
  await makeAgentTool(agent.id, prodTool.id);
  await makeAgentTool(agent.id, devTool.id);
  await makeAgentTool(agent.id, defaultTool.id);

  const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
    (tool) => tool.name,
  );

  expect(names).toContain(prodTool.name);
  expect(names).not.toContain(devTool.name);
  expect(names).not.toContain(defaultTool.name);
});

test("getMcpToolsByAgent: a Default (null) agent sees only Default tools, not named-env tools", async ({
  makeOrganization,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });

  const prodCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: prod.id,
  });
  const defaultCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: null,
  });
  const prodTool = await makeTool({ catalogId: prodCatalog.id });
  const defaultTool = await makeTool({ catalogId: defaultCatalog.id });

  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: null,
  });
  await makeAgentTool(agent.id, prodTool.id);
  await makeAgentTool(agent.id, defaultTool.id);

  const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
    (tool) => tool.name,
  );

  expect(names).toContain(defaultTool.name);
  expect(names).not.toContain(prodTool.name);
});

test("getMcpToolsByAgent: built-in (Archestra) tools are exempt from env isolation", async ({
  makeOrganization,
  makeAgent,
  makeTool,
  makeAgentTool,
  seedAndAssignArchestraTools,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: prod.id,
  });
  // Seeds the Archestra built-in catalog + tools and assigns them.
  await seedAndAssignArchestraTools(agent.id);

  const builtInTool = await makeTool({ catalogId: ARCHESTRA_MCP_CATALOG_ID });
  await makeAgentTool(agent.id, builtInTool.id);

  const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
    (tool) => tool.name,
  );

  // The built-in tool is in the null-env Archestra catalog yet remains visible
  // to a prod agent.
  expect(names).toContain(builtInTool.name);
});

test("getMcpToolsAssignedToAgent: a cross-env assigned tool is not resolved for execution", async ({
  makeOrganization,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const dev = await EnvironmentModel.create({
    organizationId: org.id,
    name: "development",
  });
  const prodCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: prod.id,
  });
  const devCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: dev.id,
  });
  const prodTool = await makeTool({ catalogId: prodCatalog.id });
  const devTool = await makeTool({ catalogId: devCatalog.id });

  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: prod.id,
  });
  await makeAgentTool(agent.id, prodTool.id);
  await makeAgentTool(agent.id, devTool.id);

  const resolved = await ToolModel.getMcpToolsAssignedToAgent(
    [prodTool.name, devTool.name],
    agent.id,
  );
  const resolvedNames = resolved.map((tool) => tool.toolName);

  expect(resolvedNames).toContain(prodTool.name);
  expect(resolvedNames).not.toContain(devTool.name);
});

test("getMcpToolsAccessibleToUser: dynamic discovery is scoped to the agent's environment", async ({
  makeOrganization,
  makeUser,
  makeInternalMcpCatalog,
  makeTool,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const prodCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: prod.id,
  });
  const defaultCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: null,
  });
  const prodTool = await makeTool({ catalogId: prodCatalog.id });
  const defaultTool = await makeTool({ catalogId: defaultCatalog.id });

  const prodNames = (
    await ToolModel.getMcpToolsAccessibleToUser({
      userId: user.id,
      organizationId: org.id,
      isAdmin: true,
      environmentId: prod.id,
    })
  ).map((tool) => tool.name);
  expect(prodNames).toContain(prodTool.name);
  expect(prodNames).not.toContain(defaultTool.name);

  const defaultNames = (
    await ToolModel.getMcpToolsAccessibleToUser({
      userId: user.id,
      organizationId: org.id,
      isAdmin: true,
      environmentId: null,
    })
  ).map((tool) => tool.name);
  expect(defaultNames).toContain(defaultTool.name);
  expect(defaultNames).not.toContain(prodTool.name);
});

test("KnowledgeBaseConnectorModel.findByOrganization: filters connectors by environment", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });

  const prodConnector = await KnowledgeBaseConnectorModel.create({
    organizationId: org.id,
    name: "prod-connector",
    connectorType: "web_crawler",
    config: { type: "web_crawler", startUrl: "https://example.com" },
    environmentId: prod.id,
  });
  const defaultConnector = await KnowledgeBaseConnectorModel.create({
    organizationId: org.id,
    name: "default-connector",
    connectorType: "web_crawler",
    config: { type: "web_crawler", startUrl: "https://example.com" },
    environmentId: null,
  });

  const prodIds = (
    await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: org.id,
      canReadAll: true,
      environmentId: prod.id,
    })
  ).map((connector) => connector.id);
  expect(prodIds).toContain(prodConnector.id);
  expect(prodIds).not.toContain(defaultConnector.id);

  const defaultIds = (
    await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: org.id,
      canReadAll: true,
      environmentId: null,
    })
  ).map((connector) => connector.id);
  expect(defaultIds).toContain(defaultConnector.id);
  expect(defaultIds).not.toContain(prodConnector.id);

  // No environment filter → both returned (management listing).
  const allIds = (
    await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: org.id,
      canReadAll: true,
    })
  ).map((connector) => connector.id);
  expect(allIds).toContain(prodConnector.id);
  expect(allIds).toContain(defaultConnector.id);
});
