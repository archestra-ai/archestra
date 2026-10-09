// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  ARCHESTRA_MCP_CATALOG_ID,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
  TOOL_COPY_FILE_SHORT_NAME,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_LIST_AGENT_RUNS_SHORT_NAME,
  TOOL_PUBLISH_APP_SHORT_NAME,
  TOOL_READ_FILE_RAW_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_REFINE_APP_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_VALIDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import { ToolModel } from "@/models";
import EnvironmentModel from "@/models/environment";
import { expect, test } from "@/test";
import {
  gateAppToolCall,
  redactAppBuiltinAuditResult,
} from "./app-tool-runtime-gate";

// The gate is the single allowlist shared by the app runtime proxy and
// preview_app_tool. These tests pin its assignment/environment/visibility behaviour
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
    meta?: Record<string, unknown> | null;
  } = {},
) {
  const org = await fx.makeOrganization();
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

test("allows an assigned tool", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { appId, toolName } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    toolName,
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
  const { appId } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  const decision = await gateAppToolCall({
    appId,
    toolName: "hf__not_assigned",
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("not assigned");
});

// A Default-environment tool on an env-bound app is ALLOWED (the org baseline)
// — see "allows an assigned Default-environment tool on an env-bound app"
// below; only tools from a different non-default environment are refused.

test("refuses a management Archestra tool, allows the reserved app built-ins", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { appId } = await setup({
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
    // The agent-side exchange tool must never be dispatchable BY an app: the
    // app namespace is hermetic and only the agent brokers across it.
    TOOL_COPY_FILE_SHORT_NAME,
    TOOL_SCAFFOLD_APP_SHORT_NAME,
    TOOL_REFINE_APP_SHORT_NAME,
    TOOL_EDIT_APP_SHORT_NAME,
    TOOL_VALIDATE_APP_SHORT_NAME,
    TOOL_PUBLISH_APP_SHORT_NAME,
  ];
  for (const shortName of authoringTools) {
    const management = await gateAppToolCall({
      appId,
      toolName: getArchestraToolFullName(shortName),
    });
    expect(management.allowed, `${shortName} must not be app-callable`).toBe(
      false,
    );
  }

  const dataStore = await gateAppToolCall({
    appId,
    toolName: getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
  });
  expect(dataStore).toEqual({ allowed: true, kind: "app-builtin" });

  const llm = await gateAppToolCall({
    appId,
    toolName: getArchestraToolFullName(TOOL_APP_LLM_COMPLETE_SHORT_NAME),
  });
  expect(llm).toEqual({ allowed: true, kind: "app-builtin" });

  const executions = await gateAppToolCall({
    appId,
    toolName: getArchestraToolFullName(TOOL_LIST_AGENT_RUNS_SHORT_NAME),
  });
  expect(executions).toEqual({ allowed: true, kind: "app-builtin" });

  // The file tools: an app's own per-viewer file store, dispatchable in-process
  // like the data store. They exist only under the sandbox runtime flag.
  const originalEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = true;
  try {
    for (const shortName of APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES) {
      const fileTool = await gateAppToolCall({
        appId,
        toolName: getArchestraToolFullName(shortName),
      });
      expect(fileTool, `${shortName} must be app-callable`).toEqual({
        allowed: true,
        kind: "app-builtin",
      });
    }
  } finally {
    config.skillsSandbox.enabled = originalEnabled;
  }
});

test("refuses the file tools when the sandbox runtime is off", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { appId } = await setup({
    makeOrganization,
    makeUser,
    makeApp,
    makeInternalMcpCatalog,
    makeTool,
    makeAppTool,
  });
  // The file tools are only registered under the sandbox flag, so the gate must
  // not admit a call the dispatcher could not resolve.
  const originalEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  try {
    for (const shortName of APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES) {
      const decision = await gateAppToolCall({
        appId,
        toolName: getArchestraToolFullName(shortName),
      });
      expect(decision.allowed, `${shortName} must be refused`).toBe(false);
    }
    // The flag-independent built-ins keep working.
    const dataStore = await gateAppToolCall({
      appId,
      toolName: getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
    });
    expect(dataStore).toEqual({ allowed: true, kind: "app-builtin" });
  } finally {
    config.skillsSandbox.enabled = originalEnabled;
  }
});

test("refuses a tool whose visibility excludes the app surface", async ({
  makeOrganization,
  makeUser,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const { appId, toolName } = await setup(
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
    toolName,
  });
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toContain("visibility");
});

test("refuses an assigned tool whose catalog left the app's environment", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
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
    toolName: tool.name,
  });
  expect(decision.allowed).toBe(false);
  expect(decision.allowed === false && decision.reason).toContain(
    "environment",
  );
});

test("allows an assigned Default-environment tool on an env-bound app", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const org = await makeOrganization();
  const prod = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  // App bound to prod; the assigned tool's catalog is in the Default
  // environment (null) — the org baseline every app may draw from, so the
  // call-time gate allows it (mirroring the assignment fence).
  const app = await makeApp({ organizationId: org.id, environmentId: prod.id });
  const defaultCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
  });
  const tool = await makeTool({
    name: `base__y_${crypto.randomUUID().slice(0, 8)}`,
    catalogId: defaultCatalog.id,
  });
  await makeAppTool(app.id, tool.id);

  const decision = await gateAppToolCall({
    appId: app.id,
    toolName: tool.name,
  });
  expect(decision.allowed).toBe(true);
});

test("allows an assigned tool in the app's bound environment", async ({
  makeOrganization,
  makeApp,
  makeInternalMcpCatalog,
  makeTool,
  makeAppTool,
}) => {
  const org = await makeOrganization();
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
    toolName: tool.name,
  });
  expect(decision).toEqual({
    allowed: true,
    kind: "upstream",
    resolvedToolName: tool.name,
  });
});

// =============================================================================
// Audit redaction — file bytes must never gain a second, long-lived DB copy in
// mcp_tool_calls, for either read shape.
// =============================================================================

test("redacts read_file content and read_file_raw contentBase64 from audit results", () => {
  const readResult = {
    isError: false,
    content: [{ type: "text" as const, text: "1\tsecret line" }],
    structuredContent: {
      fileId: "f1",
      filename: "a.txt",
      content: "secret line",
      totalLines: 1,
    },
  };
  const redactedRead = redactAppBuiltinAuditResult(
    getArchestraToolFullName(TOOL_READ_FILE_SHORT_NAME),
    readResult,
  );
  expect(JSON.stringify(redactedRead)).not.toContain("secret line");
  expect(redactedRead.structuredContent).toMatchObject({
    fileId: "f1",
    filename: "a.txt",
    totalLines: 1,
  });

  const rawResult = {
    isError: false,
    content: [{ type: "text" as const, text: '"a.bin" returned as base64.' }],
    structuredContent: {
      fileId: "f2",
      filename: "a.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      contentBase64: Buffer.from("SECRET-BYTES").toString("base64"),
    },
  };
  const redactedRaw = redactAppBuiltinAuditResult(
    getArchestraToolFullName(TOOL_READ_FILE_RAW_SHORT_NAME),
    rawResult,
  );
  expect(JSON.stringify(redactedRaw)).not.toContain(
    Buffer.from("SECRET-BYTES").toString("base64"),
  );
  expect(redactedRaw.structuredContent).toMatchObject({
    fileId: "f2",
    sizeBytes: 4,
  });

  // Errors keep their diagnostics; other tools pass through untouched.
  const errorResult = {
    isError: true,
    content: [{ type: "text" as const, text: "not found" }],
  };
  expect(
    redactAppBuiltinAuditResult(
      getArchestraToolFullName(TOOL_READ_FILE_SHORT_NAME),
      errorResult,
    ),
  ).toBe(errorResult);
  const saveResult = {
    isError: false,
    content: [{ type: "text" as const, text: "saved" }],
    structuredContent: { content: "kept for non-read tools" },
  };
  expect(
    redactAppBuiltinAuditResult(
      getArchestraToolFullName(TOOL_SAVE_FILE_SHORT_NAME),
      saveResult,
    ),
  ).toBe(saveResult);
});

// =============================================================================
// Agent-surface exclusion — an app-runtime-only tool must never exist as a tool
// row: no row means no agent assignment, no search_tools hit, no gateway
// listing.
// =============================================================================

test("seeding never creates a tool row for app-runtime-only built-ins", async () => {
  const originalEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = true;
  try {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
  } finally {
    config.skillsSandbox.enabled = originalEnabled;
  }
  const seeded = await ToolModel.findByCatalogId(ARCHESTRA_MCP_CATALOG_ID);
  const names = new Set(seeded.map((tool) => tool.name));
  expect(names.has(getArchestraToolFullName(TOOL_READ_FILE_SHORT_NAME))).toBe(
    true,
  );
  expect(
    names.has(getArchestraToolFullName(TOOL_READ_FILE_RAW_SHORT_NAME)),
  ).toBe(false);
});
