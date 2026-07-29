// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically

// T-977 regression: under "Load tools when needed" (toolExposureMode
// search_and_run_only — forced for Access-all-tools agents, optional for
// custom agents), a live MCP tool the model discovers through search_tools
// must be assignable to an app it is building: via scaffold_app's tools param
// and via set_app_tools, dispatched exactly the way the model dispatches them
// (run_tool with full agent context, so the assignment gate runs).

import {
  getArchestraToolFullName,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_SET_APP_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { AppToolModel, EnvironmentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const SCAFFOLD_APP_FULL_NAME = getArchestraToolFullName(
  TOOL_SCAFFOLD_APP_SHORT_NAME,
);
const SET_APP_TOOLS_FULL_NAME = getArchestraToolFullName(
  TOOL_SET_APP_TOOLS_SHORT_NAME,
);

function structured(result: { structuredContent?: unknown }): any {
  return result.structuredContent;
}

function resultText(result: { content: unknown }): string {
  return (result.content as Array<{ text?: string }>)
    .map((item) => item.text ?? "")
    .join("\n");
}

/** Dispatch a built-in the way a search_and_run_only model does: through run_tool. */
function runTool(
  context: ArchestraContext,
  toolName: string,
  toolArgs: Record<string, unknown>,
) {
  return executeArchestraTool(
    TOOL_RUN_TOOL_FULL_NAME,
    { tool_name: toolName, tool_args: toolArgs },
    context,
  );
}

function searchTools(context: ArchestraContext, query: string) {
  return executeArchestraTool(TOOL_SEARCH_TOOLS_FULL_NAME, { query }, context);
}

/** The searched live (source "mcp") tool names, in ranking order. */
function mcpToolNames(searchResult: { structuredContent?: unknown }): string[] {
  return (structured(searchResult).tools as Array<any>)
    .filter((tool) => tool.source === "mcp")
    .map((tool) => tool.toolName);
}

async function expectAssignsThroughFullDispatch(
  context: ArchestraContext,
  liveToolName: string,
) {
  // scaffold_app's tools param assigns the live tool at creation.
  const created = await runTool(context, SCAFFOLD_APP_FULL_NAME, {
    name: "Issue Board",
    tools: [liveToolName],
  });
  expect(created.isError, resultText(created)).toBe(false);
  expect(structured(created).status ?? "ok").toBe("ok");
  const appId = structured(created).id as string;
  expect(
    (await AppToolModel.getToolsForApp(appId)).map((tool) => tool.name),
  ).toEqual([liveToolName]);

  // set_app_tools replaces the set after the fact (clear, then re-assign).
  const cleared = await runTool(context, SET_APP_TOOLS_FULL_NAME, {
    appId,
    tools: [],
  });
  expect(cleared.isError, resultText(cleared)).toBe(false);
  const reassigned = await runTool(context, SET_APP_TOOLS_FULL_NAME, {
    appId,
    tools: [liveToolName],
  });
  expect(reassigned.isError, resultText(reassigned)).toBe(false);
  expect(structured(reassigned).tools).toEqual([liveToolName]);
}

describe("app tool assignment under Load-tools-when-needed", () => {
  let organizationId: string;
  let userId: string;
  let liveToolName: string;
  let liveToolId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      const user = await makeUser();
      userId = user.id;
      await makeMember(user.id, organizationId, { role: "member" });

      const catalog = await makeInternalMcpCatalog({ organizationId });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      liveToolName = `github__list_issues_${crypto.randomUUID().slice(0, 8)}`;
      const liveTool = await makeTool({
        name: liveToolName,
        catalogId: catalog.id,
      });
      liveToolId = liveTool.id;
    },
  );

  function contextFor(agent: Agent): ArchestraContext {
    return {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
    };
  }

  describe("Access-all-tools agent (progressive loading forced)", () => {
    let context: ArchestraContext;

    beforeEach(async ({ makeAgent, seedAndAssignArchestraTools }) => {
      const agent = await makeAgent({
        name: "All Tools Agent",
        organizationId,
        accessAllTools: true,
      });
      // Production agents get the app-authoring built-ins assigned at creation
      // (AgentModel.create auto-assigns them); the test DB seeds the Archestra
      // catalog on demand, so mirror that end state explicitly.
      await seedAndAssignArchestraTools(agent.id);
      context = contextFor(agent);
    });

    test("search_tools surfaces the live tool and the app-authoring tools", async () => {
      const liveSearch = await searchTools(context, "github list issues");
      expect(liveSearch.isError, resultText(liveSearch)).toBe(false);
      expect(mcpToolNames(liveSearch)).toContain(liveToolName);

      const authoringSearch = await searchTools(context, "set app tools");
      expect(
        (structured(authoringSearch).tools as Array<any>).map(
          (tool) => tool.toolName,
        ),
      ).toContain(SET_APP_TOOLS_FULL_NAME);
    });

    test("a searched live tool is assignable via scaffold_app and set_app_tools", async () => {
      await expectAssignsThroughFullDispatch(context, liveToolName);
    });

    test("every live tool search_tools returns is accepted by set_app_tools", async () => {
      const search = await searchTools(context, "github list issues");
      const names = mcpToolNames(search);
      expect(names.length).toBeGreaterThan(0);

      const created = await runTool(context, SCAFFOLD_APP_FULL_NAME, {
        name: "Parity Probe",
      });
      expect(created.isError, resultText(created)).toBe(false);
      const appId = structured(created).id as string;

      for (const name of names) {
        const res = await runTool(context, SET_APP_TOOLS_FULL_NAME, {
          appId,
          tools: [name],
        });
        expect(res.isError, `assigning ${name}: ${resultText(res)}`).toBe(
          false,
        );
      }
    });
  });

  describe("custom agent with progressive loading (assigned tools only)", () => {
    let context: ArchestraContext;

    beforeEach(
      async ({ makeAgent, makeAgentTool, seedAndAssignArchestraTools }) => {
        const agent = await makeAgent({
          name: "Custom Progressive Agent",
          organizationId,
          accessAllTools: false,
          toolExposureMode: "search_and_run_only",
        });
        await seedAndAssignArchestraTools(agent.id);
        await makeAgentTool(agent.id, liveToolId);
        context = contextFor(agent);
      },
    );

    test("search_tools surfaces the assigned live tool", async () => {
      const liveSearch = await searchTools(context, "github list issues");
      expect(liveSearch.isError, resultText(liveSearch)).toBe(false);
      expect(mcpToolNames(liveSearch)).toContain(liveToolName);
    });

    test("an assigned live tool is assignable via scaffold_app and set_app_tools", async () => {
      await expectAssignsThroughFullDispatch(context, liveToolName);
    });

    test("every live tool search_tools returns is accepted by set_app_tools", async () => {
      const search = await searchTools(context, "github list issues");
      const names = mcpToolNames(search);
      expect(names.length).toBeGreaterThan(0);

      const created = await runTool(context, SCAFFOLD_APP_FULL_NAME, {
        name: "Parity Probe",
      });
      expect(created.isError, resultText(created)).toBe(false);
      const appId = structured(created).id as string;

      for (const name of names) {
        const res = await runTool(context, SET_APP_TOOLS_FULL_NAME, {
          appId,
          tools: [name],
        });
        expect(res.isError, `assigning ${name}: ${resultText(res)}`).toBe(
          false,
        );
      }
    });
  });

  // An agent bound to a non-default environment only ever sees (and runs) that
  // environment's tools — search_tools fences discovery to the agent's env. The
  // tools the model discovers there must be assignable to the app it scaffolds
  // from that same agent, or the model is stuck in a loop: search_tools shows
  // the tool, scaffold_app/set_app_tools reject it with "Unknown tool name(s)…
  // Use search_tools" (T-977: "I can't assign live MCP tools to the app").
  describe("environment-bound Access-all-tools agent", () => {
    let context: ArchestraContext;
    let envToolName: string;

    beforeEach(
      async ({
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeTool,
        seedAndAssignArchestraTools,
      }) => {
        const env = await EnvironmentModel.create({
          organizationId,
          name: `Env ${crypto.randomUUID().slice(0, 8)}`,
        });
        const envCatalog = await makeInternalMcpCatalog({
          organizationId,
          environmentId: env.id,
        });
        await makeMcpServer({ catalogId: envCatalog.id, scope: "org" });
        envToolName = `envhub__list_records_${crypto.randomUUID().slice(0, 8)}`;
        await makeTool({ name: envToolName, catalogId: envCatalog.id });

        const agent = await makeAgent({
          name: "Env Agent",
          organizationId,
          accessAllTools: true,
          environmentId: env.id,
        });
        await seedAndAssignArchestraTools(agent.id);
        context = contextFor(agent);
      },
    );

    test("search_tools surfaces the environment's live tool", async () => {
      const search = await searchTools(context, "envhub list records");
      expect(search.isError, resultText(search)).toBe(false);
      expect(mcpToolNames(search)).toContain(envToolName);
    });

    test("a searched live tool is assignable via scaffold_app and set_app_tools", async () => {
      await expectAssignsThroughFullDispatch(context, envToolName);
    });

    test("set_app_tools accepts the environment's live tool on a scaffolded app", async () => {
      // The repair path scaffold_app's partial result points to must work too:
      // scaffold bare, then assign the discovered tool after the fact.
      const created = await runTool(context, SCAFFOLD_APP_FULL_NAME, {
        name: "Env Records Board",
      });
      expect(created.isError, resultText(created)).toBe(false);
      const appId = structured(created).id as string;

      const res = await runTool(context, SET_APP_TOOLS_FULL_NAME, {
        appId,
        tools: [envToolName],
      });
      expect(res.isError, resultText(res)).toBe(false);
      expect(structured(res).tools).toEqual([envToolName]);
    });
  });
});
