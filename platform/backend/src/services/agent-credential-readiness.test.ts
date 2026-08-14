import McpServerUserModel from "@/models/mcp-server-user";
import {
  assertCallerMayStartTurn,
  getAgentCredentialReadiness,
} from "@/services/agent-credential-readiness";
import { expect, test } from "@/test";
import type { MissingCredentialBehavior } from "@/types/agent";

type TestContext = Parameters<Parameters<typeof test>[1]>[0];
type SetupFixtures = Pick<
  TestContext,
  | "makeUser"
  | "makeAgent"
  | "makeInternalMcpCatalog"
  | "makeTool"
  | "makeAgentTool"
>;

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
