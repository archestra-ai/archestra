// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ADMIN_ROLE_NAME,
  getArchestraToolFullName,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_CREATE_APP_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_UPDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import { AppModel, AppToolModel, AppVersionModel } from "@/models";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

// App tools are only dispatchable when the feature is enabled.
const originalAppsEnabled = config.apps.enabled;
beforeAll(() => {
  (config.apps as { enabled: boolean }).enabled = true;
});
afterAll(() => {
  (config.apps as { enabled: boolean }).enabled = originalAppsEnabled;
});

function structured(result: { structuredContent?: unknown }): any {
  return result.structuredContent;
}

describe("app tool execution", () => {
  let context: ArchestraContext;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    const agent = await makeAgent({ name: "App Agent" });
    organizationId = agent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    // No agentId → management tools skip the agent-assignment gate.
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId: user.id,
    };
  });

  test("create → list → get → update (forks version) → delete", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Dashboard", html: "<h1>v1</h1>" },
      context,
    );
    expect(created.isError).toBe(false);
    const appId = structured(created).id as string;
    expect(structured(created).latestVersion).toBe(1);
    // The model hands this link to the user; the chat UI renders inline from structuredContent.id.
    expect((created.content[0] as any).text).toContain(`/apps/${appId}/run`);

    const listed = await executeArchestraTool(
      getArchestraToolFullName(TOOL_LIST_APPS_SHORT_NAME),
      {},
      context,
    );
    expect(structured(listed).apps.map((a: any) => a.id)).toContain(appId);

    const got = await executeArchestraTool(
      getArchestraToolFullName(TOOL_RENDER_APP_SHORT_NAME),
      { appId },
      context,
    );
    expect(structured(got).name).toBe("Dashboard");

    const updated = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId, html: "<h1>v2</h1>" },
      context,
    );
    expect(structured(updated).latestVersion).toBe(2);

    const deleted = await executeArchestraTool(
      getArchestraToolFullName(TOOL_DELETE_APP_SHORT_NAME),
      { appId },
      context,
    );
    expect(deleted.isError).toBe(false);
    expect(await AppModel.findById(appId)).toBeNull();
  });

  test("a plain member cannot create or mutate org-scoped apps", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ name: "Member Agent" });
    const member = await makeUser();
    await makeMember(member.id, agent.organizationId, { role: "member" });
    const memberCtx: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      organizationId: agent.organizationId,
      userId: member.id,
    };

    // Member may create a personal app...
    const personal = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Mine", html: "<p/>" },
      memberCtx,
    );
    expect(personal.isError).toBe(false);

    // ...but not an org-scoped one.
    const orgCreate = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Shared", html: "<p/>", scope: "org" },
      memberCtx,
    );
    expect(orgCreate.isError).toBe(true);

    // An org app created by an admin (the suite context) cannot be deleted or
    // re-scoped by a plain member, even though it is visible to them.
    const orgApp = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "AdminApp", html: "<p/>", scope: "org" },
      context,
    );
    const orgAppId = structured(orgApp).id as string;

    const delAttempt = await executeArchestraTool(
      getArchestraToolFullName(TOOL_DELETE_APP_SHORT_NAME),
      { appId: orgAppId },
      memberCtx,
    );
    expect(delAttempt.isError).toBe(true);
    expect(await AppModel.findById(orgAppId)).not.toBeNull();
  });

  test("create rejects an invalid CSP domain", async () => {
    const result = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      {
        name: "BadCsp",
        html: "<p/>",
        uiCsp: { connectDomains: ["https://evil.example.com"] },
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("invalid CSP domain");
  });

  test("an html-only update preserves the existing CSP", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      {
        name: "Keeps CSP",
        html: "<h1>v1</h1>",
        uiCsp: { connectDomains: ["api.example.com"] },
      },
      context,
    );
    const appId = structured(created).id as string;

    const updated = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId, html: "<h1>v2</h1>" },
      context,
    );
    expect(updated.isError).toBe(false);

    const head = await AppVersionModel.findByAppAndVersion(
      appId,
      structured(updated).latestVersion as number,
    );
    expect(head?.uiCsp).toEqual({ connectDomains: ["api.example.com"] });
  });

  test("create seeds from a template when html is omitted", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "From Template", templateId: "form" },
      context,
    );
    expect(created.isError).toBe(false);
    const appId = structured(created).id as string;

    const head = await AppVersionModel.findByAppAndVersion(appId, 1);
    expect(head?.html).toContain("window.archestra.storage.user.set");
    // Scaffold-then-edit: the seeded html rides the result text so the model
    // can update_app without a read-back.
    expect((created.content[0] as any).text).toContain(
      "window.archestra.storage.user.set",
    );

    // Explicit html wins over templateId (provenance only) and returns no seed.
    const explicit = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Explicit", html: "<h1>mine</h1>", templateId: "form" },
      context,
    );
    expect(explicit.isError).toBe(false);
    const explicitHead = await AppVersionModel.findByAppAndVersion(
      structured(explicit).id as string,
      1,
    );
    expect(explicitHead?.html).toBe("<h1>mine</h1>");
    expect((explicit.content[0] as any).text).not.toContain("Seeded from");
  });

  test("create rejects unknown templateId and missing html+templateId", async () => {
    const unknown = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Nope", templateId: "no-such-template" },
      context,
    );
    expect(unknown.isError).toBe(true);
    expect((unknown.content[0] as any).text).toContain("Unknown templateId");

    const neither = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Empty" },
      context,
    );
    expect(neither.isError).toBe(true);
    expect((neither.content[0] as any).text).toContain(
      "Either html or templateId",
    );
  });

  test("create rejects SDK self-bootstrap html; update surfaces warnings", async () => {
    const bootstrap = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      {
        name: "Bootstrapper",
        html: "<html><head><script>const t = new PostMessageTransport(window.parent, window.parent);</script></head><body/></html>",
      },
      context,
    );
    expect(bootstrap.isError).toBe(true);
    expect((bootstrap.content[0] as any).text).toContain("window.archestra");

    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Warned", html: "<html><head></head><body/></html>" },
      context,
    );
    expect(structured(created).warnings).toBeUndefined();

    const updated = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId: structured(created).id, html: "<h1>fragment</h1>" },
      context,
    );
    expect(updated.isError).toBe(false);
    expect(structured(updated).warnings).toHaveLength(1);
    expect((updated.content[0] as any).text).toContain("Validation warnings");
  });

  test("create reports a name conflict cleanly", async () => {
    await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Dup", html: "<p/>", scope: "org" },
      context,
    );
    const second = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Dup", html: "<p/>", scope: "org" },
      context,
    );
    expect(second.isError).toBe(true);
    expect((second.content[0] as any).text).toContain("already exists");
  });
});

describe("app data store tools", () => {
  let context: ArchestraContext;

  beforeEach(async ({ makeApp, makeUser, makeMember }) => {
    const app = await makeApp();
    // The viewing user (a member holds app:read/update); appId is route-bound by
    // the app proxy — simulate that binding here.
    const user = await makeUser();
    await makeMember(user.id, app.organizationId, { role: "member" });
    context = {
      agent: { id: "app-runtime", name: "app" },
      organizationId: app.organizationId,
      userId: user.id,
      appId: app.id,
    };
  });

  test("set/get/list/delete round-trip scoped to the app", async () => {
    const set = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
      { key: "counter", value: { n: 1 } },
      context,
    );
    expect(set.isError).toBe(false);

    const got = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
      { key: "counter" },
      context,
    );
    expect((got.structuredContent as any).value).toEqual({ n: 1 });

    const listed = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_LIST_SHORT_NAME),
      {},
      context,
    );
    expect((listed.structuredContent as any).entries).toEqual([
      { key: "counter", value: { n: 1 } },
    ]);

    const deleted = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_DELETE_SHORT_NAME),
      { key: "counter" },
      context,
    );
    expect(deleted.isError).toBe(false);
  });

  test("refuses when there is no bound app (not running as an app)", async () => {
    const result = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
      { key: "x" },
      { ...context, appId: undefined },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("only available");
  });

  test("scope defaults to the viewer partition; app scope is shared", async ({
    makeUser,
    makeMember,
  }) => {
    // biome-ignore lint/style/noNonNullAssertion: set in beforeEach
    const organizationId = context.organizationId!;
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const otherContext = { ...context, userId: otherUser.id };

    await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
      { key: "fav", value: "mine" },
      context,
    );
    await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
      { key: "fav", value: "everyone", scope: "app" },
      context,
    );

    // another viewer sees the shared value but not the first viewer's
    const theirOwn = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
      { key: "fav" },
      otherContext,
    );
    expect((theirOwn.structuredContent as any).value).toBeNull();
    const shared = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
      { key: "fav", scope: "app" },
      otherContext,
    );
    expect((shared.structuredContent as any).value).toBe("everyone");
  });

  test("user scope without an authenticated viewer fails closed", async () => {
    // the centralized RBAC check rejects a missing userId before the handler's
    // own guard; either way the call must error rather than fall back to the
    // shared partition
    const result = await executeArchestraTool(
      getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
      { key: "x", value: 1 },
      { ...context, userId: undefined },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(
      /user context|authenticated viewer/i,
    );
  });
});

describe("create_app/update_app tools param", () => {
  let context: ArchestraContext;
  let organizationId: string;
  let paperSearchName: string;
  let statsName: string;

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent({ name: "Tools Agent" });
      organizationId = agent.organizationId;
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      context = {
        agent: { id: agent.id, name: agent.name },
        organizationId,
        userId: user.id,
      };

      const catalog = await makeInternalMcpCatalog({ organizationId });
      paperSearchName = `hf__paper_search_${crypto.randomUUID().slice(0, 8)}`;
      statsName = `hf__stats_${crypto.randomUUID().slice(0, 8)}`;
      await makeTool({ name: paperSearchName, catalogId: catalog.id });
      await makeTool({ name: statsName, catalogId: catalog.id });
    },
  );

  test("create assigns the tools with dynamic credential resolution", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Papers", html: "<p/>", tools: [paperSearchName] },
      context,
    );
    expect(created.isError).toBe(false);
    expect(structured(created).tools).toEqual([paperSearchName]);

    const assignments = await AppToolModel.getAssignmentsForApp(
      structured(created).id as string,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0].tool.name).toBe(paperSearchName);
    // dynamic mode: server + credential resolve per viewing user at call time
    expect(assignments[0].credentialResolutionMode).toBe("dynamic");
    expect(assignments[0].mcpServerId).toBeNull();
  });

  test("create with an unknown tool name fails and leaves no app behind", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Ghost", html: "<p/>", tools: ["nope__missing"] },
      context,
    );
    expect(created.isError).toBe(true);
    expect((created.content[0] as any).text).toContain("nope__missing");

    const listed = await executeArchestraTool(
      getArchestraToolFullName(TOOL_LIST_APPS_SHORT_NAME),
      { name: "Ghost" },
      context,
    );
    expect(structured(listed).apps).toEqual([]);
  });

  test("built-in tool names are rejected", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      {
        name: "Builtin",
        html: "<p/>",
        tools: [getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME)],
      },
      context,
    );
    expect(created.isError).toBe(true);
    expect((created.content[0] as any).text).toContain("Built-in");
  });

  test("another org's tool name does not resolve", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const foreignCatalog = await makeInternalMcpCatalog();
    const foreignName = `foreign__tool_${crypto.randomUUID().slice(0, 8)}`;
    await makeTool({ name: foreignName, catalogId: foreignCatalog.id });

    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "CrossOrg", html: "<p/>", tools: [foreignName] },
      context,
    );
    expect(created.isError).toBe(true);
    expect((created.content[0] as any).text).toContain("Unknown tool name");
  });

  test("update replaces the assignment set declaratively; [] clears it", async () => {
    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
      { name: "Replace", html: "<p/>", tools: [paperSearchName] },
      context,
    );
    const appId = structured(created).id as string;

    const swapped = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId, tools: [statsName] },
      context,
    );
    expect(swapped.isError).toBe(false);
    expect(structured(swapped).tools).toEqual([statsName]);
    let names = (await AppToolModel.getToolsForApp(appId)).map((t) => t.name);
    expect(names).toEqual([statsName]);

    // an unknown name fails the whole replace — the old set stays intact
    const failed = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId, tools: [statsName, "nope__missing"] },
      context,
    );
    expect(failed.isError).toBe(true);
    names = (await AppToolModel.getToolsForApp(appId)).map((t) => t.name);
    expect(names).toEqual([statsName]);

    const cleared = await executeArchestraTool(
      getArchestraToolFullName(TOOL_UPDATE_APP_SHORT_NAME),
      { appId, tools: [] },
      context,
    );
    expect(cleared.isError).toBe(false);
    expect(structured(cleared).tools).toEqual([]);
    expect(await AppToolModel.getToolsForApp(appId)).toEqual([]);
  });
});
