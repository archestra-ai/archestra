import { resolveDynamicTool } from "@/archestra-mcp-server/dynamic-tools";
import { EnvironmentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { buildAppCapabilityContext } from "./app-capability-context";

describe("buildAppCapabilityContext", () => {
  test("returns only the user's app-assignable MCP tools, RBAC/org-filtered", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTool,
    makeAgentTool,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });

    // App-assignable: catalog-backed MCP tool in the caller's org, assigned to
    // the agent — the user can both reach and assign it.
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const assignable = await makeTool({
      name: "github__list_issues",
      description: "List issues in a repo",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, assignable.id);

    // Assigned to the agent but NOT app-assignable: a proxy tool has no
    // catalogId, so apps cannot attach it — it must not leak into the grounding.
    const proxyTool = await makeTool({
      name: "proxy__do_thing",
      description: "Proxy tool",
    });
    await makeAgentTool(agent.id, proxyTool.id);

    // Assigned to the agent but owned by a DIFFERENT org's catalog: the user
    // cannot assign a foreign-org tool to their app, so it is filtered out.
    const otherOrg = await makeOrganization();
    const foreignCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
    });
    const foreignTool = await makeTool({
      name: "slack__post_message",
      description: "Post to slack",
      catalogId: foreignCatalog.id,
    });
    await makeAgentTool(agent.id, foreignTool.id);

    const context = await buildAppCapabilityContext({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      environmentId: null,
    });

    expect(context.tools).toEqual([
      { name: "github__list_issues", description: "List issues in a repo" },
    ]);
  });

  test("a duplicate tool name is grounded once, resolved to the canonical row", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    // Dynamic access on, so discoverable (unassigned) tools are grounded.
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllTools: true,
    });

    // Two installed catalogs carry a tool with the SAME name (unique only per
    // catalog) but DIFFERENT descriptions, so the assertion pins which row won.
    // The old grounding dropped such names; it must now list the name once,
    // described by the same canonical row search_tools/run_tool resolve.
    const dupName = "acme__do_thing";
    for (const description of ["first catalog", "second catalog"]) {
      const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({ name: dupName, description, catalogId: catalog.id });
    }

    const canonical = await resolveDynamicTool({
      toolName: dupName,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(canonical).not.toBeNull();

    const context = await buildAppCapabilityContext({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      environmentId: null,
    });

    expect(context.tools.filter((tool) => tool.name === dupName)).toEqual([
      { name: dupName, description: canonical?.description ?? "" },
    ]);
  });

  test("grounds in the app's environment, not the authoring agent's", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    // Agent runs in the default environment; the app is bound elsewhere.
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllTools: true,
    });
    const appEnv = await EnvironmentModel.create({
      organizationId: org.id,
      name: `Prod ${crypto.randomUUID().slice(0, 8)}`,
    });

    // A tool only in the app's (non-default) environment.
    const appEnvCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      environmentId: appEnv.id,
    });
    await makeMcpServer({ catalogId: appEnvCatalog.id, scope: "org" });
    await makeTool({ name: "prod__deploy", catalogId: appEnvCatalog.id });

    // A tool only in the default environment (the agent's env).
    const defaultCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
    });
    await makeMcpServer({ catalogId: defaultCatalog.id, scope: "org" });
    await makeTool({ name: "default__thing", catalogId: defaultCatalog.id });

    const context = await buildAppCapabilityContext({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      environmentId: appEnv.id,
    });

    const names = context.tools.map((tool) => tool.name);
    // Grounds the app-env tool, not the agent-env one.
    expect(names).toContain("prod__deploy");
    expect(names).not.toContain("default__thing");
  });

  test("describes the window.archestra SDK surface", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });

    const context = await buildAppCapabilityContext({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      environmentId: null,
    });

    expect(context.sdkSummary.length).toBeGreaterThan(0);
    expect(context.sdkSummary).toContain("archestra.storage");
    expect(context.sdkSummary).toContain("archestra.tools.call");
  });
});
