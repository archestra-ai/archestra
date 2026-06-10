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
import { AppModel, AppVersionModel } from "@/models";
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
    expect(head?.html).toContain("window.archestra.data.set");
    // Scaffold-then-edit: the seeded html rides the result text so the model
    // can update_app without a read-back.
    expect((created.content[0] as any).text).toContain(
      "window.archestra.data.set",
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
});
