// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  getArchestraToolFullName,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_CREATE_APP_SHORT_NAME,
} from "@archestra/shared";
import { expect, test } from "@/test";
import { gateAppToolCall } from "./app-tool-runtime-gate";

// The gate is the single allowlist shared by the app runtime proxy and
// preview_app_tool. These tests pin its assignment/visibility/policy behaviour
// directly — the gate never executes a tool, so no live MCP server is needed.

async function setup(
  fx: {
    makeOrganization: any;
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
    appId: app.id as string,
    toolId: tool.id as string,
    toolName: tool.name as string,
  };
}

test("allows an assigned tool with no policy", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, appId, toolName } = await setup({
    makeOrganization,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(decision).toEqual({
    allowed: true,
    kind: "upstream",
    resolvedToolName: toolName,
  });
});

test("refuses a tool not assigned to the app", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, appId } = await setup({
    makeOrganization,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    toolName: "hf__not_assigned",
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("not assigned");
});

test("refuses a management Archestra tool, allows the data store", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, appId } = await setup({
    makeOrganization,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const management = await gateAppToolCall({
    appId,
    organizationId,
    toolName: getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(management.allowed).toBe(false);

  const dataStore = await gateAppToolCall({
    appId,
    organizationId,
    toolName: getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(dataStore).toEqual({ allowed: true, kind: "app-data" });
});

test("refuses a tool whose visibility excludes the app surface", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { organizationId, appId, toolName } = await setup(
    {
      makeOrganization,
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
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("visibility");
});

test("enforces a block_always policy on the target (runtime gap fix)", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, appId, toolId, toolName } = await setup({
    makeOrganization,
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
      toolName,
      toolInput: {},
      isContextTrusted: true,
      treatRequireApprovalAsBlock,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("policy");
  }
});

test("require_approval blocks the runtime but not preview", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, appId, toolId, toolName } = await setup({
    makeOrganization,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  await makeToolPolicy(toolId, { conditions: [], action: "require_approval" });

  const runtime = await gateAppToolCall({
    appId,
    organizationId,
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
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: false,
  });
  expect(preview.allowed).toBe(true);
});

test("an untrusted context fires a block_when_context_is_untrusted policy", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, appId, toolId, toolName } = await setup({
    makeOrganization,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  await makeToolPolicy(toolId, {
    conditions: [],
    action: "block_when_context_is_untrusted",
  });

  // trusted authoring context → allowed
  const trusted = await gateAppToolCall({
    appId,
    organizationId,
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: false,
  });
  expect(trusted.allowed).toBe(true);

  // untrusted context → blocked (preview must not strip this signal)
  const untrusted = await gateAppToolCall({
    appId,
    organizationId,
    toolName,
    toolInput: {},
    isContextTrusted: false,
    treatRequireApprovalAsBlock: false,
  });
  expect(untrusted.allowed).toBe(false);
});

test("a permissive org skips policy enforcement", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
  makeToolPolicy,
}) => {
  const { organizationId, appId, toolId, toolName } = await setup(
    {
      makeOrganization,
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
    toolName,
    toolInput: {},
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  expect(decision.allowed).toBe(true);
});
