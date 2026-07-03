// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  type ArchestraToolShortName,
  CONTEXT_TEAM_IDS,
  getArchestraToolFullName,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import EnvironmentModel from "@/models/environment";
import { expect, test } from "@/test";
import { gateAppToolCall } from "./app-tool-runtime-gate";

// The gate is the single allowlist shared by the app runtime proxy and
// preview_app_tool. These tests pin its assignment/visibility/policy behaviour
// directly — the gate never executes a tool, so no live MCP server is needed.

async function setup(
  fx: {
    makeOrganization: any;
    makeUser: any;
    makeApp: any;
    makeInternalMcpCatalog: any;
    makeTool: any;
    makeAppTool: any;
  },
  options: {
    globalToolPolicy?: "permissive" | "restrictive";
    meta?: Record<string, unknown> | null;
  } = {},
) {
  const org = await fx.makeOrganization({
    globalToolPolicy: options.globalToolPolicy ?? "restrictive",
  });
  const user = await fx.makeUser();
  const app = await fx.makeApp({ organizationId: org.id });
  const catalog = await fx.makeInternalMcpCatalog({ organizationId: org.id });
  const tool = await fx.makeTool({
    name: `hf__search_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: catalog.id,
    ...(options.meta !== undefined ? { meta: options.meta } : {}),
  });
  await fx.makeAppTool(app.id, tool.id);
  return {
    organizationId: org.id as string,
    userId: user.id as string,
    appId: app.id as string,
    toolId: tool.id as string,
    toolName: tool.name as string,
  };
}

const BASE = {
  isContextTrusted: true,
  treatRequireApprovalAsBlock: true,
} as const;

test("allows an assigned tool with no policy", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, userId, appId, toolName } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    ...BASE,
  });
  expect(decision).toEqual({
    allowed: true,
    kind: "upstream",
    resolvedToolName: toolName,
  });
});

test("refuses a tool not assigned to the app", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, userId, appId } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName: "hf__not_assigned",
    toolInput: {},
    ...BASE,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("not assigned");
});

test("refuses an assigned tool whose catalog is outside the app's bound environment", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  // Permissive org so the policy engine short-circuits to allow — the env fence
  // (which runs before policy) is the only thing that can refuse here.
  const org = await makeOrganization({ globalToolPolicy: "permissive" });
  const user = await makeUser();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  // The app's environment is derived from its backing catalog (FR-30); the
  // fixture routes environmentId there.
  const app = await makeApp({ organizationId: org.id, environmentId: prod.id });
  // The tool's catalog is in the default (null) environment — not prod.
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const tool = await makeTool({
    name: `hf__search_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: catalog.id,
  });
  await makeAppTool(app.id, tool.id);

  const decision = await gateAppToolCall({
    appId: app.id,
    organizationId: org.id,
    userId: user.id,
    toolName: tool.name,
    toolInput: {},
    ...BASE,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("environment");
});

test("refuses a management Archestra tool, allows the reserved app built-ins", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, userId, appId } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  // Every authoring/management tool is rejected from the app surface — only the
  // reserved app built-ins below are dispatchable as an app.
  const authoringTools: ArchestraToolShortName[] = [
    TOOL_SCAFFOLD_APP_SHORT_NAME,
    TOOL_REFINE_APP_SHORT_NAME,
    TOOL_EDIT_APP_SHORT_NAME,
    TOOL_VALIDATE_APP_SHORT_NAME,
    TOOL_PUBLISH_APP_SHORT_NAME,
  ];
  for (const shortName of authoringTools) {
    const management = await gateAppToolCall({
      appId,
      organizationId,
      userId,
      toolName: getArchestraToolFullName(shortName),
      toolInput: {},
      ...BASE,
    });
    expect(management.allowed, `${shortName} must not be app-callable`).toBe(
      false,
    );
  }

  const dataStore = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName: getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
    toolInput: {},
    ...BASE,
  });
  expect(dataStore).toEqual({ allowed: true, kind: "app-builtin" });

  const llm = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName: getArchestraToolFullName(TOOL_APP_LLM_COMPLETE_SHORT_NAME),
    toolInput: {},
    ...BASE,
  });
  expect(llm).toEqual({ allowed: true, kind: "app-builtin" });
});

test("refuses a tool whose visibility excludes the app surface", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, userId, appId, toolName } = await setup(
    {
      makeOrganization,
      makeUser,
      makeApp,
      makeInternalMcpCatalog,
      makeTool,
      makeAppTool,
    },
    { meta: { _meta: { ui: { visibility: ["model"] } } } },
  );
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    ...BASE,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("visibility");
});

test("enforces a block_always policy on the target (runtime gap fix)", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, userId, appId, toolId, toolName } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  await makeToolPolicy(toolId, { conditions: [], action: "block_always" });

  for (const treatRequireApprovalAsBlock of [true, false]) {
    const decision = await gateAppToolCall({
      appId,
      organizationId,
      userId,
      toolName,
      toolInput: {},
      isContextTrusted: true,
      treatRequireApprovalAsBlock,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // Attribute the guardrail to Archestra so the app (and whoever reads the
      // error) knows the gateway blocked the call, not the tool.
      expect(decision.reason).toContain(
        "a security guardrail enforced by Archestra, not by the tool itself",
      );
    }
  }
});

test("require_approval blocks the runtime but not preview", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, userId, appId, toolId, toolName } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  await makeToolPolicy(toolId, { conditions: [], action: "require_approval" });

  const runtime = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(runtime.allowed).toBe(false);
  if (!runtime.allowed) expect(runtime.reason).toContain("approval");

  const preview = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: false,
  });
  expect(preview.allowed).toBe(true);
});

test("an untrusted context fires a block_when_context_is_untrusted policy", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, userId, appId, toolId, toolName } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  await makeToolPolicy(toolId, {
    conditions: [],
    action: "block_when_context_is_untrusted",
  });

  const trusted = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: false,
  });
  expect(trusted.allowed).toBe(true);

  const untrusted = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    isContextTrusted: false,
    treatRequireApprovalAsBlock: false,
  });
  expect(untrusted.allowed).toBe(false);
});

test("a team-scoped policy is matched against the viewer's teams", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeTeam,
  makeTeamMember,
  makeToolPolicy,
}) => {
  const org = await makeOrganization({ globalToolPolicy: "restrictive" });
  const inTeam = await makeUser();
  const outOfTeam = await makeUser();
  const team = await makeTeam(org.id, inTeam.id);
  await makeTeamMember(team.id, inTeam.id);
  const app = await makeApp({ organizationId: org.id });
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const tool = await makeTool({
    name: `hf__team_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: catalog.id,
  });
  await makeAppTool(app.id, tool.id);
  await makeToolPolicy(tool.id, {
    conditions: [
      { key: CONTEXT_TEAM_IDS, operator: "contains", value: team.id },
    ],
    action: "block_always",
  });

  // viewer in the team → the team-scoped policy matches and blocks
  const blocked = await gateAppToolCall({
    appId: app.id,
    organizationId: org.id,
    userId: inTeam.id,
    toolName: tool.name,
    toolInput: {},
    ...BASE,
  });
  expect(blocked.allowed).toBe(false);

  // viewer outside the team → the condition does not match
  const allowed = await gateAppToolCall({
    appId: app.id,
    organizationId: org.id,
    userId: outOfTeam.id,
    toolName: tool.name,
    toolInput: {},
    ...BASE,
  });
  expect(allowed.allowed).toBe(true);
});

test("a permissive org skips policy enforcement", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, userId, appId, toolId, toolName } = await setup(
    {
      makeOrganization,
      makeUser,
      makeApp,
      makeInternalMcpCatalog,
      makeTool,
      makeAppTool,
    },
    { globalToolPolicy: "permissive" },
  );
  await makeToolPolicy(toolId, { conditions: [], action: "block_always" });

  const decision = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput: {},
    ...BASE,
  });
  expect(decision.allowed).toBe(true);
});

test("refuses an assigned tool whose catalog left the app's environment", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const org = await makeOrganization({ globalToolPolicy: "permissive" });
  const user = await makeUser();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const dev = await EnvironmentModel.create({
    organizationId: org.id,
    name: "development",
  });
  // App bound to prod; the assigned tool's catalog is in dev — a stale
  // assignment that survives a re-bind. The call-time gate refuses it even
  // though the app_tools row is still present.
  const app = await makeApp({ organizationId: org.id, environmentId: prod.id });
  const devCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: dev.id,
  });
  const tool = await makeTool({
    name: `dev__x_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: devCatalog.id,
  });
  await makeAppTool(app.id, tool.id);

  const decision = await gateAppToolCall({
    appId: app.id,
    organizationId: org.id,
    userId: user.id,
    toolName: tool.name,
    toolInput: {},
    ...BASE,
  });
  expect(decision.allowed).toBe(false);
  expect(decision.allowed === false && decision.reason).toContain(
    "environment",
  );
});

test("allows an assigned tool in the app's bound environment", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const org = await makeOrganization({ globalToolPolicy: "permissive" });
  const user = await makeUser();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const app = await makeApp({ organizationId: org.id, environmentId: prod.id });
  const prodCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    environmentId: prod.id,
  });
  const tool = await makeTool({
    name: `prod__x_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: prodCatalog.id,
  });
  await makeAppTool(app.id, tool.id);

  const decision = await gateAppToolCall({
    appId: app.id,
    organizationId: org.id,
    userId: user.id,
    toolName: tool.name,
    toolInput: {},
    ...BASE,
  });
  expect(decision).toEqual({
    allowed: true,
    kind: "upstream",
    resolvedToolName: tool.name,
  });
});
