import McpServerUserModel from "@/models/mcp-server-user";
import {
  assertCallerMayStartTurn,
  getAgentCredentialReadiness,
} from "@/services/agent-credential-readiness";
import { expect, test } from "@/test";
import type { MissingCredentialBehavior } from "@/types/agent";

/** Structural view of the fixtures this file's setup helper needs. */
type SetupFixtures = {
  makeUser: () => Promise<{ id: string }>;
  makeAgent: (overrides: {
    agentType: "agent";
    scope: "org";
    missingCredentialBehavior: MissingCredentialBehavior;
    accessAllTools: boolean;
  }) => Promise<{ id: string }>;
  makeInternalMcpCatalog: (overrides: {
    name: string;
  }) => Promise<{ id: string; name: string }>;
  makeTool: (overrides: { catalogId: string }) => Promise<{ id: string }>;
  makeAgentTool: (agentId: string, toolId: string) => Promise<unknown>;
};

/**
 * An agent with one tool from one MCP server, plus a caller who does not have
 * that server connected. This is the shape the setting exists for: an agent
 * shared with the org whose author connected one of its servers personally.
 */
async function setupSharedAgent(
  fixtures: SetupFixtures,
  options: {
    missingCredentialBehavior: MissingCredentialBehavior;
    accessAllTools?: boolean;
    catalogName?: string;
  },
) {
  const caller = await fixtures.makeUser();
  const catalog = await fixtures.makeInternalMcpCatalog({
    name: options.catalogName ?? "Acme Docs",
  });
  const agent = await fixtures.makeAgent({
    agentType: "agent",
    scope: "org",
    missingCredentialBehavior: options.missingCredentialBehavior,
    accessAllTools: options.accessAllTools ?? false,
  });
  const tool = await fixtures.makeTool({ catalogId: catalog.id });
  await fixtures.makeAgentTool(agent.id, tool.id);

  return { caller, catalog, agent };
}

test("reports nothing for agents left on the default behavior", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const { caller, agent } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "allow" },
  );

  const readiness = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "allow",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness).toEqual([]);
});

test("names the server a caller has no connection to", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const { caller, agent, catalog } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "warn", catalogName: "Acme Docs" },
  );

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "warn",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([
    { catalogId: catalog.id, catalogName: "Acme Docs" },
  ]);
});

test("counts the caller's own personal install as connected", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
  makeMcpServer,
}) => {
  const { caller, agent, catalog } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "block" },
  );

  const install = await makeMcpServer({
    catalogId: catalog.id,
    ownerId: caller.id,
    scope: "personal",
  });
  await McpServerUserModel.assignUserToMcpServer(install.id, caller.id);

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([]);
});

test("counts an org-wide install as connected for a caller who does not own it", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
  makeMcpServer,
}) => {
  const { caller, agent, catalog } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "block" },
  );
  const someoneElse = await makeUser();

  await makeMcpServer({
    catalogId: catalog.id,
    ownerId: someoneElse.id,
    scope: "org",
  });

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([]);
});

test("does not count another user's personal install as connected", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
  makeMcpServer,
}) => {
  const { caller, agent, catalog } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "block" },
  );
  const author = await makeUser();

  const install = await makeMcpServer({
    catalogId: catalog.id,
    ownerId: author.id,
    scope: "personal",
  });
  await McpServerUserModel.assignUserToMcpServer(install.id, author.id);

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toHaveLength(1);
});

test("exempts Auto-tool agents, which resolve tools per caller", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const { caller, agent } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "block", accessAllTools: true },
  );

  const readiness = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: true,
      },
    ],
    userId: caller.id,
  });

  expect(readiness).toEqual([]);
  await expect(
    assertCallerMayStartTurn({ agentId: agent.id, userId: caller.id }),
  ).resolves.toBeUndefined();
});

test("refuses the turn for a blocking agent and names what to connect", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const { caller, agent } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "block", catalogName: "Acme Docs" },
  );

  await expect(
    assertCallerMayStartTurn({ agentId: agent.id, userId: caller.id }),
  ).rejects.toThrow(/Acme Docs/);
});

test("treats a statically pinned tool as connected for everyone", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
  makeMcpServer,
}) => {
  // A static pin is the service-account case: the runtime routes every caller
  // through the pinned install without checking they can reach it, so refusing
  // the caller here would block a tool call that would have worked.
  const caller = await makeUser();
  const author = await makeUser();
  const catalog = await makeInternalMcpCatalog({ name: "Acme Docs" });
  const agent = await makeAgent({
    agentType: "agent",
    scope: "org",
    missingCredentialBehavior: "block",
    accessAllTools: false,
  });
  const tool = await makeTool({ catalogId: catalog.id });
  const pinnedInstall = await makeMcpServer({
    catalogId: catalog.id,
    ownerId: author.id,
    scope: "personal",
  });
  await makeAgentTool(agent.id, tool.id, {
    mcpServerId: pinnedInstall.id,
    credentialResolutionMode: "static",
  });

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([]);
  await expect(
    assertCallerMayStartTurn({ agentId: agent.id, userId: caller.id }),
  ).resolves.toBeUndefined();
});

test("falls back to the caller's own connection when a static pin is gone", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  // Uninstalling the pinned server clears the assignment's pin but keeps the
  // assignment. The runtime then resolves per caller, so readiness must too.
  const caller = await makeUser();
  const catalog = await makeInternalMcpCatalog({ name: "Acme Docs" });
  const agent = await makeAgent({
    agentType: "agent",
    scope: "org",
    missingCredentialBehavior: "block",
    accessAllTools: false,
  });
  const tool = await makeTool({ catalogId: catalog.id });
  await makeAgentTool(agent.id, tool.id, {
    credentialResolutionMode: "static",
  });

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([
    { catalogId: catalog.id, catalogName: "Acme Docs" },
  ]);
});

test("treats enterprise-managed credentials as connected for everyone", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const caller = await makeUser();
  const catalog = await makeInternalMcpCatalog({ name: "Acme Docs" });
  const agent = await makeAgent({
    agentType: "agent",
    scope: "org",
    missingCredentialBehavior: "block",
    accessAllTools: false,
  });
  const tool = await makeTool({ catalogId: catalog.id });
  await makeAgentTool(agent.id, tool.id, {
    credentialResolutionMode: "enterprise_managed",
  });

  const [readiness] = await getAgentCredentialReadiness({
    agents: [
      {
        id: agent.id,
        missingCredentialBehavior: "block",
        accessAllTools: false,
      },
    ],
    userId: caller.id,
  });

  expect(readiness.missingConnections).toEqual([]);
});

test("lets the turn through when the agent only warns", async ({
  makeUser,
  makeAgent,
  makeInternalMcpCatalog,
  makeTool,
  makeAgentTool,
}) => {
  const { caller, agent } = await setupSharedAgent(
    { makeUser, makeAgent, makeInternalMcpCatalog, makeTool, makeAgentTool },
    { missingCredentialBehavior: "warn" },
  );

  await expect(
    assertCallerMayStartTurn({ agentId: agent.id, userId: caller.id }),
  ).resolves.toBeUndefined();
});
