import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentToolModel from "@/models/agent-tool";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import mcpClient from "./mcp-client";

test("tool listing shares membership across catalogs and reloads it on the next listing", async ({
  makeOrganization,
  makeUser,
  makeAgent,
  makeTeam,
  makeTeamMember,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const team = await makeTeam(org.id, user.id);
  await makeTeamMember(team.id, user.id);
  const agent = await makeAgent({ organizationId: org.id });
  const tools = [];
  const expected = new Map<string, string>();
  for (let index = 0; index < 3; index++) {
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
    });
    const tool = await makeTool({ catalogId: catalog.id });
    await AgentToolModel.create(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });
    tools.push(tool);
    expected.set(tool.name, server.id);
  }
  const params = { agentId: agent.id, tokenAuth: { userId: user.id }, tools };
  const measured = await recordQueries(() =>
    mcpClient.resolveToolInstallsForCaller(params),
  );
  expect(measured.result).toEqual(expected);
  expect(
    measured.statements.filter((statement) =>
      statement.includes('from "team_member"'),
    ),
  ).toHaveLength(1);
  await db
    .delete(schema.teamMembersTable)
    .where(
      and(
        eq(schema.teamMembersTable.teamId, team.id),
        eq(schema.teamMembersTable.userId, user.id),
      ),
    );
  expect(await mcpClient.resolveToolInstallsForCaller(params)).toEqual(
    new Map(),
  );
});
