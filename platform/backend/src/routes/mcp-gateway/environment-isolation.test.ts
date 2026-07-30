import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_MCP_SERVER_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_GET_MCP_SERVERS_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  AppModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  UserTokenModel,
} from "@/models";
import { afterEach, beforeEach, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

/**
 * Route-level environment isolation for the agent-facing surface. Everything an
 * agent reaches goes through `POST /v1/mcp/:agentId`, so these drive the real
 * gateway (auth, tool resolution, dispatch) rather than calling handlers
 * directly. An agent bound to environment E must only discover, act on, and
 * create resources in E — matching the tools it can actually call.
 *
 * Regressions these pin:
 * - the registry tools listed the whole organization's catalog regardless of
 *   the calling agent's environment;
 * - a server or app the agent created landed in the Default environment instead
 *   of the agent's, leaving its author unable to see it afterwards.
 *
 * The caller is an org admin throughout, so a missing result is always an
 * environment decision and never RBAC masking one.
 */

const LAUNCH = "Launch";
const EXPLORE = "Explore";

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

function toolName(shortName: string): string {
  return `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;
}

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(mcpGatewayRoutes);
});

afterEach(async () => {
  await app.close();
});

type ToolCallBody = {
  result: {
    isError?: boolean;
    structuredContent?: { items?: { id: string }[]; id?: string };
    content: Array<{ type: string; text?: string }>;
  };
};

async function callTool(params: {
  agentId: string;
  token: string;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<ToolCallBody> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}`,
    headers: makeMcpHeaders(params.token),
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: params.name, arguments: params.arguments },
      id: 1,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ToolCallBody;
}

function resultText(body: ToolCallBody): string {
  return body.result.content.map((item) => item.text ?? "").join("\n");
}

test("gateway: get_mcp_servers lists only the calling agent's environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const launch = await EnvironmentModel.create({
    organizationId: org.id,
    name: LAUNCH,
  });
  const explore = await EnvironmentModel.create({
    organizationId: org.id,
    name: EXPLORE,
  });
  const agent = await makeAgent({
    name: "Launch Agent",
    organizationId: org.id,
    environmentId: launch.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const token = await UserTokenModel.create(user.id, org.id);

  const launchCatalog = await makeInternalMcpCatalog({
    name: "Launch Server",
    organizationId: org.id,
    environmentId: launch.id,
  });
  const exploreCatalog = await makeInternalMcpCatalog({
    name: "Explore Server",
    organizationId: org.id,
    environmentId: explore.id,
  });
  const defaultCatalog = await makeInternalMcpCatalog({
    name: "Default Server",
    organizationId: org.id,
    environmentId: null,
  });

  const body = await callTool({
    agentId: agent.id,
    token: token.value,
    name: toolName(TOOL_GET_MCP_SERVERS_SHORT_NAME),
    arguments: {},
  });

  expect(body.result.isError).toBeFalsy();
  const ids = (body.result.structuredContent?.items ?? []).map(
    (item) => item.id,
  );
  expect(ids).toContain(launchCatalog.id);
  expect(ids).not.toContain(exploreCatalog.id);
  expect(ids).not.toContain(defaultCatalog.id);
});

test("gateway: search_private_mcp_registry does not surface other environments", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const launch = await EnvironmentModel.create({
    organizationId: org.id,
    name: LAUNCH,
  });
  const explore = await EnvironmentModel.create({
    organizationId: org.id,
    name: EXPLORE,
  });
  const agent = await makeAgent({
    name: "Launch Agent",
    organizationId: org.id,
    environmentId: launch.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const token = await UserTokenModel.create(user.id, org.id);

  const launchCatalog = await makeInternalMcpCatalog({
    name: "observability launch",
    organizationId: org.id,
    environmentId: launch.id,
  });
  const exploreCatalog = await makeInternalMcpCatalog({
    name: "observability explore",
    organizationId: org.id,
    environmentId: explore.id,
  });

  const body = await callTool({
    agentId: agent.id,
    token: token.value,
    name: toolName(TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME),
    arguments: { query: "observability" },
  });

  expect(body.result.isError).toBeFalsy();
  const ids = (body.result.structuredContent?.items ?? []).map(
    (item) => item.id,
  );
  expect(ids).toEqual([launchCatalog.id]);
  expect(ids).not.toContain(exploreCatalog.id);
  expect(resultText(body)).not.toContain("observability explore");
});

test("gateway: get_mcp_server_tools hides a server from another environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
  makeInternalMcpCatalog,
  makeTool,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const launch = await EnvironmentModel.create({
    organizationId: org.id,
    name: LAUNCH,
  });
  const explore = await EnvironmentModel.create({
    organizationId: org.id,
    name: EXPLORE,
  });
  const agent = await makeAgent({
    name: "Launch Agent",
    organizationId: org.id,
    environmentId: launch.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const token = await UserTokenModel.create(user.id, org.id);

  const exploreCatalog = await makeInternalMcpCatalog({
    name: "Explore Only",
    organizationId: org.id,
    environmentId: explore.id,
  });
  await makeTool({ catalogId: exploreCatalog.id, name: "explore_only_tool" });

  const body = await callTool({
    agentId: agent.id,
    token: token.value,
    name: toolName(TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME),
    arguments: { mcpServerId: exploreCatalog.id },
  });

  expect(body.result.isError).toBe(true);
  const text = resultText(body);
  expect(text).toContain("not found");
  // The fence must not leak the out-of-environment server's tools.
  expect(text).not.toContain("explore_only_tool");
});

test("gateway: create_mcp_server lands in the calling agent's environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const launch = await EnvironmentModel.create({
    organizationId: org.id,
    name: LAUNCH,
  });
  const agent = await makeAgent({
    name: "Launch Agent",
    organizationId: org.id,
    environmentId: launch.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const token = await UserTokenModel.create(user.id, org.id);

  const body = await callTool({
    agentId: agent.id,
    token: token.value,
    name: toolName(TOOL_CREATE_MCP_SERVER_SHORT_NAME),
    arguments: {
      name: "Gateway Authored Server",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    },
  });

  expect(body.result.isError).toBeFalsy();
  const created = await InternalMcpCatalogModel.findByName(
    "Gateway Authored Server",
  );
  expect(created?.environmentId).toBe(launch.id);
});

test("gateway: scaffold_app binds the app to the calling agent's environment", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const launch = await EnvironmentModel.create({
    organizationId: org.id,
    name: LAUNCH,
  });
  const agent = await makeAgent({
    name: "Launch Agent",
    organizationId: org.id,
    environmentId: launch.id,
  });
  await seedAndAssignArchestraTools(agent.id);
  const token = await UserTokenModel.create(user.id, org.id);

  const body = await callTool({
    agentId: agent.id,
    token: token.value,
    name: toolName(TOOL_SCAFFOLD_APP_SHORT_NAME),
    arguments: { name: "Launch Dashboard" },
  });

  expect(body.result.isError).toBeFalsy();
  const appId = body.result.structuredContent?.id;
  expect(appId).toBeTruthy();

  // An app's environment is owned by its backing catalog row, not the apps
  // table — `AppModel.findById` joins it back in.
  const scaffolded = await AppModel.findById(appId as string);
  expect(scaffolded?.environmentId).toBe(launch.id);
});
