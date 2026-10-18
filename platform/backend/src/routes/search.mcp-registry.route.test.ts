import {
  ARCHESTRA_MCP_CATALOG_ID,
  attentionRankTiers,
  canReauthenticateConnection,
  computeMcpServerIssues,
  createMcpServerAlertFingerprint,
  isPermissionActionGranted,
  MAX_BULK_IDS,
  type McpDeploymentStatusEntry,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import db, { schema } from "@/database";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpCatalogLabelModel,
  McpServerAlertMuteModel,
  McpServerModel,
  TeamModel,
  UserModel,
} from "@/models";
import McpServerUserModel from "@/models/mcp-server-user";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { useRouteTestApp } from "@/test/route-test-app";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

type RegistryRow = {
  id: string;
  name: string;
  icon: string | null;
  iconUrl: string | null;
  toolCount: number;
  install: {
    visibleCount: number;
    installedForViewer: boolean;
    primaryServerId: string | null;
  };
};

type RegistryPage = {
  data: RegistryRow[];
  selectableTotal: number;
  pagination: { total: number; totalPages: number; hasNext: boolean };
};

const SVG_ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
).toString("base64")}`;

describe("MCP registry list routes", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async ({ makeMember }) => {
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: ctx.user.id } }) as never,
    );
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const search = async (body: Record<string, unknown> = {}) => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog/registry/search",
      payload: {
        limit: 100,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
        ...body,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as RegistryPage;
  };
  const names = (page: RegistryPage) => page.data.map((row) => row.name);

  const makeItem = async (
    makeInternalMcpCatalog: (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string; name: string }>,
    name: string,
    overrides: Record<string, unknown> = {},
  ) =>
    makeInternalMcpCatalog({
      name,
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      ...overrides,
    });

  // A new filter or sort key also belongs in the frontend's registry mocks
  // (frontend/src/mocks/registry.ts); a spec that uses it there otherwise
  // passes without any filtering.
  describe("POST /api/internal_mcp_catalog/registry/search", () => {
    test("resolves the caller's membership, teams and grants once per request", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      for (const name of ["alpha", "bravo", "charlie"]) {
        const item = await makeItem(makeInternalMcpCatalog, name);
        await makeMcpServer({
          catalogId: item.id,
          ownerId: ctx.user.id,
          scope: "personal",
        });
      }
      await search(); // warm

      const { statements } = await recordQueries(() => search());
      const reads = (table: string) =>
        statements.filter((sql) =>
          new RegExp(`from "${table}"(?! *where "${table}"."id" =)`).test(sql),
        ).length;

      // Each check, the page read and its decoration used to resolve the
      // caller again: 40 statements, the role and team lookups three times.
      expect(reads("organization_role")).toBe(1);
      expect(reads("team_member")).toBe(1);
      expect(statements.length).toBeLessThanOrEqual(25);
    });

    test("pages in SQL and counts every match", async ({
      makeInternalMcpCatalog,
    }) => {
      for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
        await makeItem(makeInternalMcpCatalog, name);
      }

      const first = await search({ limit: 2, offset: 0 });
      const third = await search({ limit: 2, offset: 4 });

      expect(names(first)).toEqual(["alpha", "bravo"]);
      expect(first.pagination).toMatchObject({
        total: 5,
        totalPages: 3,
        hasNext: true,
      });
      expect(names(third)).toEqual(["echo"]);
      expect(third.pagination.hasNext).toBe(false);
      const pastTheEnd = await search({ limit: 2, offset: 10 });
      expect(pastTheEnd.data).toEqual([]);
      expect(pastTheEnd.pagination.total).toBe(5);
    });

    test("never lists the built-in Archestra entry", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeInternalMcpCatalog({
        id: ARCHESTRA_MCP_CATALOG_ID,
        name: "Archestra",
        serverType: "builtin",
        organizationId: null,
      });
      await makeItem(makeInternalMcpCatalog, "github");

      const page = await search();

      expect(names(page)).toEqual(["github"]);
      expect(page.pagination.total).toBe(1);
    });

    test("searches names case-insensitively and treats wildcards literally", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeItem(makeInternalMcpCatalog, "GitHub Issues");
      await makeItem(makeInternalMcpCatalog, "gitlab");
      await makeItem(makeInternalMcpCatalog, "100%_done");
      await makeItem(makeInternalMcpCatalog, "100 percent");

      expect(names(await search({ search: "git" }))).toEqual(
        ["gitlab", "GitHub Issues"].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase()),
        ),
      );
      expect(names(await search({ search: "%_" }))).toEqual(["100%_done"]);
    });

    test("labels match every key and any value within a key", async ({
      makeInternalMcpCatalog,
    }) => {
      const devGold = await makeItem(makeInternalMcpCatalog, "dev-gold");
      const devSilver = await makeItem(makeInternalMcpCatalog, "dev-silver");
      const opsGold = await makeItem(makeInternalMcpCatalog, "ops-gold");
      await McpCatalogLabelModel.syncCatalogLabels(devGold.id, [
        { key: "category", value: "dev" },
        { key: "tier", value: "gold" },
      ]);
      await McpCatalogLabelModel.syncCatalogLabels(devSilver.id, [
        { key: "category", value: "dev" },
        { key: "tier", value: "silver" },
      ]);
      await McpCatalogLabelModel.syncCatalogLabels(opsGold.id, [
        { key: "category", value: "ops" },
        { key: "tier", value: "gold" },
      ]);

      expect(
        names(await search({ labels: { category: ["dev"], tier: ["gold"] } })),
      ).toEqual(["dev-gold"]);
      expect(
        names(
          await search({
            labels: { category: ["dev", "ops"], tier: ["gold"] },
          }),
        ),
      ).toEqual(["dev-gold", "ops-gold"]);
    });

    test("filters by environment, author and catalog ids", async ({
      makeInternalMcpCatalog,
      makeUser,
      makeMember,
    }) => {
      const other = await makeUser();
      await makeMember(other.id, ctx.organizationId, { role: "member" });
      const mine = await makeItem(makeInternalMcpCatalog, "mine");
      const theirs = await makeItem(makeInternalMcpCatalog, "theirs", {
        authorId: other.id,
      });

      expect(names(await search({ authorIds: [other.id] }))).toEqual([
        "theirs",
      ]);
      expect(names(await search({ catalogIds: [mine.id] }))).toEqual(["mine"]);
      expect((await search({ catalogIds: [] })).pagination.total).toBe(0);
      expect(
        names(await search({ environmentIds: [crypto.randomUUID()] })),
      ).toEqual([]);
      expect(theirs.id).toBeTruthy();
      // Items in the Default environment have no environment id, and the
      // registry's environment filter lists named environments only.
      const production = await EnvironmentModel.create({
        organizationId: ctx.organizationId,
        name: "Production",
      });
      await makeItem(makeInternalMcpCatalog, "in-production", {
        environmentId: production.id,
      });
      expect(names(await search({ environmentIds: [production.id] }))).toEqual([
        "in-production",
      ]);
    });

    test("refuses an unknown sort, a page size out of range and an oversized body", async () => {
      const post = (payload: Record<string, unknown>) =>
        ctx.app.inject({
          method: "POST",
          url: "/api/internal_mcp_catalog/registry/search",
          payload: { limit: 10, offset: 0, ...payload },
        });

      expect((await post({ sortBy: "popularity" })).statusCode).toBe(400);
      expect((await post({ limit: 0 })).statusCode).toBe(400);
      expect((await post({ limit: -1 })).statusCode).toBe(400);
      expect((await post({ offset: -1 })).statusCode).toBe(400);
      expect(
        (await post({ labels: { key: ["x".repeat(257)] } })).statusCode,
      ).toBe(400);
      // About 14,000 ids: over the body limit before any parsing.
      const ids = Array.from({ length: 14_000 }, () => crypto.randomUUID());
      expect((await post({ rankTiers: [ids] })).statusCode).toBe(413);
    });

    test("refuses more label keys than one query should join", async () => {
      const labels = Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [`key-${i}`, ["value"]]),
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search",
        payload: { limit: 10, offset: 0, labels },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("At most 50 label keys");
      const fifty = Object.fromEntries(Object.entries(labels).slice(0, 50));
      expect((await search({ labels: fifty })).data).toEqual([]);
    });

    test("combines search, labels, install state and access in one query", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeTeam,
    }) => {
      const other = await makeUser();
      await makeMember(other.id, ctx.organizationId, { role: "member" });
      const items = new Map<string, { id: string }>();
      for (const [name, authorId, installed] of [
        ["dev-mine-installed", ctx.user.id, true],
        ["dev-mine-bare", ctx.user.id, false],
        ["dev-theirs-installed", other.id, true],
        ["ops-mine-installed", ctx.user.id, true],
      ] as const) {
        const item = await makeItem(makeInternalMcpCatalog, name, { authorId });
        await McpCatalogLabelModel.syncCatalogLabels(item.id, [
          { key: "category", value: name.split("-")[0] },
        ]);
        if (installed) {
          await makeMcpServer({
            catalogId: item.id,
            ownerId: ctx.user.id,
            scope: "org",
          });
        }
        items.set(name, item);
      }

      const page = await search({
        search: "mine",
        labels: { category: ["dev"] },
        installState: "installed",
        access: ["mine"],
      });

      expect(names(page)).toEqual(["dev-mine-installed"]);
      expect(page.pagination.total).toBe(1);
      expect(names(await search({ owner: [other.id] }))).toEqual([
        "dev-theirs-installed",
      ]);
      expect(names(await search({ access: ["mine"], search: "dev" }))).toEqual([
        "dev-mine-bare",
        "dev-mine-installed",
      ]);
      const team = await makeTeam(ctx.organizationId, ctx.user.id);
      const shared = {
        organizationId: ctx.organizationId,
        resource: "mcpRegistry",
        scope: items.get("ops-mine-installed")?.id ?? "",
      } as const;
      const policy = await ResourcePermissionPolicyModel.find(shared);
      await ResourcePermissionPolicyModel.replace({
        ...shared,
        revision: policy?.revision ?? 0,
        grants: [{ subject: { type: "team", id: team.id }, actions: ["read"] }],
      });
      expect(names(await search({ sharedWith: [`team:${team.id}`] }))).toEqual([
        "ops-mine-installed",
      ]);
    });

    test("an author filter matches items a service account created", async ({
      makeInternalMcpCatalog,
      makeServiceAccount,
    }) => {
      const account = await makeServiceAccount(ctx.organizationId);
      await makeItem(makeInternalMcpCatalog, "by-user");
      const byAccount = await makeItem(makeInternalMcpCatalog, "by-account");
      // Made through a service account on the user's behalf: it shows, and
      // filters, as the service account's.
      const onBehalf = await makeItem(makeInternalMcpCatalog, "on-behalf");
      await db
        .update(schema.internalMcpCatalogTable)
        .set({ authorId: null, createdByServiceAccountId: account.id })
        .where(eq(schema.internalMcpCatalogTable.id, byAccount.id));
      await db
        .update(schema.internalMcpCatalogTable)
        .set({ createdByServiceAccountId: account.id })
        .where(eq(schema.internalMcpCatalogTable.id, onBehalf.id));

      expect(
        names(await search({ authorServiceAccountIds: [account.id] })),
      ).toEqual(["by-account", "on-behalf"]);
      expect(names(await search({ authorIds: [ctx.user.id] }))).toEqual([
        "by-user",
      ]);
      expect(
        names(
          await search({
            authorIds: [ctx.user.id],
            authorServiceAccountIds: [account.id],
          }),
        ),
      ).toEqual(["by-account", "by-user", "on-behalf"]);

      const index = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/internal_mcp_catalog/registry/issue-index",
        })
      ).json();
      expect(
        index.catalogItems.find(
          (row: { id: string }) => row.id === byAccount.id,
        ),
      ).toMatchObject({
        createdByServiceAccountId: account.id,
        authorName: account.name,
      });
    });

    test("installed means an install the viewer can see and use", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
    }) => {
      const colleague = await makeUser();
      await makeMember(colleague.id, ctx.organizationId, { role: "member" });
      const own = await makeItem(makeInternalMcpCatalog, "own");
      const othersOnly = await makeItem(makeInternalMcpCatalog, "others-only");
      await makeItem(makeInternalMcpCatalog, "untouched");
      const ownServer = await makeMcpServer({
        catalogId: own.id,
        ownerId: ctx.user.id,
        scope: "personal",
      });
      await McpServerUserModel.assignUserToMcpServer(ownServer.id, ctx.user.id);
      // The admin sees a colleague's personal install but cannot use it.
      const colleagueServer = await makeMcpServer({
        catalogId: othersOnly.id,
        ownerId: colleague.id,
        scope: "personal",
      });
      await McpServerUserModel.assignUserToMcpServer(
        colleagueServer.id,
        colleague.id,
      );

      expect(names(await search({ installState: "installed" }))).toEqual([
        "own",
      ]);
      expect(names(await search({ installState: "not-installed" }))).toEqual([
        "others-only",
        "untouched",
      ]);
      const rows = new Map((await search()).data.map((row) => [row.name, row]));
      expect(rows.get("own")?.install).toEqual({
        visibleCount: 1,
        installedForViewer: true,
        primaryServerId: ownServer.id,
      });
      expect(rows.get("others-only")?.install).toEqual({
        visibleCount: 1,
        installedForViewer: false,
        primaryServerId: colleagueServer.id,
      });
      expect(rows.get("untouched")?.install.visibleCount).toBe(0);
      // The page carries its own installs, as GET /api/mcp_server returns them.
      const page = await search();
      expect(
        (
          page as unknown as {
            installs: Array<{ id: string; canUseCredential: boolean }>;
          }
        ).installs
          .map((server) => [server.id, server.canUseCredential])
          .sort(),
      ).toEqual(
        [
          [ownServer.id, true],
          [colleagueServer.id, false],
        ].sort(),
      );
      expect((await search()).selectableTotal).toBe(2);
      // Select all picks the same rows the count promises, a visible install
      // the viewer cannot use included.
      const ids = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search/ids",
        payload: { sortBy: "name", sortDirection: "asc" },
      });
      expect(
        (ids.json() as { data: Array<{ name: string }> }).data.map(
          (row) => row.name,
        ),
      ).toEqual(["others-only", "own"]);
    });

    test("orders by name, creation time and tool count", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const b = await makeItem(makeInternalMcpCatalog, "Bravo");
      const a = await makeItem(makeInternalMcpCatalog, "alpha");
      const c = await makeItem(makeInternalMcpCatalog, "charlie");
      for (let i = 0; i < 3; i++) {
        await makeTool({ name: `charlie__t${i}`, catalogId: c.id });
      }
      await makeTool({ name: "bravo__t0", catalogId: b.id });

      expect(
        names(await search({ sortBy: "name", sortDirection: "asc" })),
      ).toEqual(["alpha", "Bravo", "charlie"]);
      expect(
        names(await search({ sortBy: "name", sortDirection: "desc" })),
      ).toEqual(["charlie", "Bravo", "alpha"]);
      expect(
        names(await search({ sortBy: "createdAt", sortDirection: "desc" })),
      ).toEqual(["charlie", "alpha", "Bravo"]);
      const byTools = await search({
        sortBy: "toolCount",
        sortDirection: "desc",
      });
      expect(names(byTools)).toEqual(["charlie", "Bravo", "alpha"]);
      expect(byTools.data.map((row) => row.toolCount)).toEqual([3, 1, 0]);
      expect(a.id).toBeTruthy();
    });

    test("attention orders by the sent rank, then installed, then name", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const yours = await makeItem(makeInternalMcpCatalog, "zulu-yours");
      const others = await makeItem(makeInternalMcpCatalog, "yankee-others");
      await makeItem(makeInternalMcpCatalog, "beta-plain");
      const installed = await makeItem(makeInternalMcpCatalog, "x-installed");
      await makeItem(makeInternalMcpCatalog, "alpha-plain");
      await makeMcpServer({
        catalogId: installed.id,
        ownerId: ctx.user.id,
        scope: "org",
      });

      const page = await search({
        sortBy: "attention",
        rankTiers: [[yours.id], [others.id]],
      });

      expect(names(page)).toEqual([
        "zulu-yours",
        "yankee-others",
        "x-installed",
        "alpha-plain",
        "beta-plain",
      ]);
    });

    test("attention without any ranked item orders by installed, then name", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeItem(makeInternalMcpCatalog, "bravo");
      await makeItem(makeInternalMcpCatalog, "alpha");

      expect(names(await search({ sortBy: "attention" }))).toEqual([
        "alpha",
        "bravo",
      ]);
      expect(
        names(await search({ sortBy: "issueAge", rankTiers: [] })),
      ).toEqual(["alpha", "bravo"]);
    });

    test("issue age orders by the sent rank, then newest", async ({
      makeInternalMcpCatalog,
    }) => {
      const oldestIssue = await makeItem(makeInternalMcpCatalog, "first");
      const newerIssue = await makeItem(makeInternalMcpCatalog, "second");
      await makeItem(makeInternalMcpCatalog, "third");
      await makeItem(makeInternalMcpCatalog, "fourth");

      const page = await search({
        sortBy: "issueAge",
        rankTiers: [[oldestIssue.id], [newerIssue.id]],
      });

      expect(names(page)).toEqual(["first", "second", "fourth", "third"]);
    });

    test("serves image icons by URL and keeps emoji inline", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeItem(makeInternalMcpCatalog, "image", { icon: SVG_ICON });
      await makeItem(makeInternalMcpCatalog, "emoji", { icon: "🐙" });

      const rows = new Map((await search()).data.map((row) => [row.name, row]));

      expect(rows.get("emoji")).toMatchObject({ icon: "🐙", iconUrl: null });
      expect(rows.get("image")?.icon).toBeNull();
      expect(rows.get("image")?.iconUrl).toMatch(
        /^\/api\/internal_mcp_catalog\/[0-9a-f-]+\/icon\?v=/,
      );
    });

    test("links and serves only image types a browser shows", async ({
      makeInternalMcpCatalog,
    }) => {
      const tiff = await makeItem(makeInternalMcpCatalog, "tiff", {
        icon: "data:image/tiff;base64,SUkqAA==",
      });

      const row = (await search()).data.find((item) => item.name === "tiff");
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${tiff.id}/icon`,
      });

      expect(row).toMatchObject({ icon: null, iconUrl: null });
      expect(response.statusCode).toBe(404);
    });

    test("a plain member lists only what they may read, and sees only their installs", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const admin = ctx.user;
      const member = await makeUser();
      await makeMember(member.id, ctx.organizationId, { role: "member" });
      const team = await makeTeam(ctx.organizationId, admin.id);
      await makeTeamMember(team.id, member.id);
      const otherTeam = await makeTeam(ctx.organizationId, admin.id);

      const shared = await makeItem(makeInternalMcpCatalog, "shared");
      await makeItem(makeInternalMcpCatalog, "admins-personal", {
        access: "personal",
      });
      const teamInstall = await makeMcpServer({
        catalogId: shared.id,
        ownerId: admin.id,
        teamId: team.id,
        scope: "team",
      });
      await makeMcpServer({
        catalogId: shared.id,
        ownerId: admin.id,
        teamId: otherTeam.id,
        scope: "team",
      });
      ctx.user = member;

      const page = await search();

      expect(names(page)).toEqual(["shared"]);
      expect(page.pagination.total).toBe(1);
      expect(page.data[0].install).toEqual({
        visibleCount: 1,
        installedForViewer: true,
        primaryServerId: teamInstall.id,
      });
    });
  });

  describe("a viewer who may read the registry but not installs", () => {
    test("sees no install data on any registry route; a plain member still does", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      await makeCustomRole(ctx.organizationId, {
        role: "registry_reader",
        permission: { mcpRegistry: ["read"] },
      });
      const reader = await makeUser();
      await makeMember(reader.id, ctx.organizationId, {
        role: "registry_reader",
      });
      const member = await makeUser();
      await makeMember(member.id, ctx.organizationId, { role: "member" });
      // Shared with both users directly, so only the install permission
      // differs between them.
      const access = { users: [reader.id, member.id] };
      const item = await makeItem(makeInternalMcpCatalog, "installed-for-all", {
        access,
      });
      await makeItem(makeInternalMcpCatalog, "untouched", { access });
      const orgInstall = await makeMcpServer({
        catalogId: item.id,
        ownerId: ctx.user.id,
        scope: "org",
        localInstallationStatus: "error",
      });

      const readAs = async (userId: string) => {
        ctx.user = { ...ctx.user, id: userId };
        const page = (await search()) as RegistryPage & {
          installs: Array<{ id: string }>;
        };
        const installed = await search({ installState: "installed" });
        const attention = await search({ sortBy: "attention" });
        const ids = (
          await ctx.app.inject({
            method: "POST",
            url: "/api/internal_mcp_catalog/registry/search/ids",
            payload: {},
          })
        ).json();
        const index = (
          await ctx.app.inject({
            method: "GET",
            url: "/api/internal_mcp_catalog/registry/issue-index",
          })
        ).json();
        return { page, installed, attention, ids, index };
      };

      const asReader = await readAs(reader.id);
      expect(names(asReader.page)).toEqual(["installed-for-all", "untouched"]);
      expect(asReader.page.installs).toEqual([]);
      expect(asReader.page.selectableTotal).toBe(0);
      for (const row of asReader.page.data) {
        expect(row.install).toEqual({
          visibleCount: 0,
          installedForViewer: false,
          primaryServerId: null,
        });
      }
      expect(asReader.installed.pagination.total).toBe(0);
      expect(names(asReader.attention)).toEqual([
        "installed-for-all",
        "untouched",
      ]);
      expect(asReader.ids).toEqual({ data: [], truncated: false });
      expect(asReader.index.servers).toEqual([]);

      const asMember = await readAs(member.id);
      expect(asMember.page.installs.map((server) => server.id)).toEqual([
        orgInstall.id,
      ]);
      expect(asMember.page.selectableTotal).toBe(1);
      expect(names(asMember.installed)).toEqual(["installed-for-all"]);
      expect(asMember.ids.data.map((row: { id: string }) => row.id)).toEqual([
        item.id,
      ]);
      expect(asMember.index.servers.map((s: { id: string }) => s.id)).toEqual([
        orgInstall.id,
      ]);
    });
  });

  describe("POST /api/internal_mcp_catalog/registry/search/ids", () => {
    test("returns every matching item that has a visible install, across pages", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const servers = new Map<string, string>();
      for (const name of ["a1", "a2", "a3", "b1"]) {
        const item = await makeItem(makeInternalMcpCatalog, name);
        if (name !== "a3") {
          const server = await makeMcpServer({
            catalogId: item.id,
            ownerId: ctx.user.id,
            scope: "org",
          });
          servers.set(name, server.id);
        }
      }

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search/ids",
        payload: { search: "a", sortBy: "name", sortDirection: "asc" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            id: expect.any(String),
            name: "a1",
            primaryServerId: servers.get("a1"),
          },
          {
            id: expect.any(String),
            name: "a2",
            primaryServerId: servers.get("a2"),
          },
        ],
        truncated: false,
      });
    });

    test("applies the same filters as the page", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      for (const [name, category] of [
        ["dev-one", "dev"],
        ["dev-two", "dev"],
        ["ops-one", "ops"],
      ] as const) {
        const item = await makeItem(makeInternalMcpCatalog, name);
        await McpCatalogLabelModel.syncCatalogLabels(item.id, [
          { key: "category", value: category },
        ]);
        await makeMcpServer({
          catalogId: item.id,
          ownerId: ctx.user.id,
          scope: "org",
        });
      }
      const filters = {
        search: "one",
        labels: { category: ["dev"] },
        installState: "installed",
        access: ["mine"],
        sortBy: "name",
        sortDirection: "asc",
      };

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search/ids",
        payload: filters,
      });

      expect(
        (response.json() as { data: Array<{ name: string }> }).data.map(
          (row) => row.name,
        ),
      ).toEqual(["dev-one"]);
      expect(names(await search(filters))).toEqual(["dev-one"]);
    });

    test("caps the answer at the bulk limit and says so", async () => {
      const matching = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => ({
        id: crypto.randomUUID(),
        name: `item-${String(i).padStart(4, "0")}`,
      }));
      const findMatching = vi
        .spyOn(InternalMcpCatalogModel, "findRegistryMatchingIds")
        .mockResolvedValue(matching);
      vi.spyOn(McpServerModel, "findRegistryInstallRows").mockResolvedValue(
        matching.map((item) => ({
          id: crypto.randomUUID(),
          catalogId: item.id,
          scope: "org",
          ownerId: ctx.user.id,
          usable: true,
        })) as never,
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search/ids",
        payload: { sortBy: "name", sortDirection: "asc" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: string }>;
        truncated: boolean;
      };
      expect(body.truncated).toBe(true);
      expect(body.data.map((row) => row.id)).toEqual(
        matching.slice(0, MAX_BULK_IDS).map((item) => item.id),
      );
      // Items without a visible install are left out in SQL, so they never
      // use up the cap, and one row past it is enough to tell it was cut.
      expect(findMatching).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: MAX_BULK_IDS + 1,
          withVisibleInstall: true,
        }),
      );
    });
  });

  describe("GET /api/internal_mcp_catalog/registry/issue-index", () => {
    test("carries every visible item and install without icons or configuration", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeOrganization,
    }) => {
      const item = await makeItem(makeInternalMcpCatalog, "broken", {
        icon: SVG_ICON,
      });
      const server = await makeMcpServer({
        catalogId: item.id,
        ownerId: ctx.user.id,
        scope: "org",
        localInstallationStatus: "error",
        oauthRefreshError: "refresh_failed" as const,
      });
      // Another organization's item and its install never reach this one.
      const otherOrganization = await makeOrganization();
      const foreign = await makeInternalMcpCatalog({
        name: "foreign",
        organizationId: otherOrganization.id,
      });
      await makeMcpServer({ catalogId: foreign.id, scope: "org" });

      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/internal_mcp_catalog/registry/issue-index",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.catalogItems).toEqual([
        expect.objectContaining({ id: item.id, name: "broken" }),
      ]);
      // Empty fields are left out, and nothing heavy is carried.
      for (const key of [
        "icon",
        "localConfig",
        "alertMutes",
        "environmentId",
      ]) {
        expect(body.catalogItems[0]).not.toHaveProperty(key);
      }
      expect(body.servers).toEqual([
        expect.objectContaining({
          id: server.id,
          catalogId: item.id,
          canUseCredential: true,
          localInstallationStatus: "error",
          oauthRefreshError: "refresh_failed" as const,
        }),
      ]);
      expect(body.servers[0]).not.toHaveProperty("teamId");
      expect(body.servers[0]).not.toHaveProperty("oauthRefreshErrorMessage");
    });
  });

  describe("GET /api/internal_mcp_catalog/:id/icon", () => {
    test("serves the image with a validator and answers a revalidation with 304", async ({
      makeInternalMcpCatalog,
    }) => {
      const item = await makeItem(makeInternalMcpCatalog, "image", {
        icon: SVG_ICON,
      });

      const first = await ctx.app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${item.id}/icon`,
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers["content-type"]).toContain("image/svg+xml");
      expect(first.headers["cache-control"]).toContain("private");
      expect(first.body).toContain("<svg");
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();

      const second = await ctx.app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${item.id}/icon`,
        headers: { "if-none-match": etag },
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe("");
    });

    test("is not found for an emoji icon or an item the caller cannot read", async ({
      makeInternalMcpCatalog,
      makeUser,
      makeMember,
    }) => {
      const emoji = await makeItem(makeInternalMcpCatalog, "emoji", {
        icon: "🐙",
      });
      const hidden = await makeItem(makeInternalMcpCatalog, "hidden", {
        icon: SVG_ICON,
        access: "personal",
      });
      const member = await makeUser();
      await makeMember(member.id, ctx.organizationId, { role: "member" });

      const emojiResponse = await ctx.app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${emoji.id}/icon`,
      });
      ctx.user = member;
      const hiddenResponse = await ctx.app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${hidden.id}/icon`,
      });

      expect(emojiResponse.statusCode).toBe(404);
      expect(hiddenResponse.statusCode).toBe(404);
    });
  });

  test("GET /api/internal_mcp_catalog/:id carries the list figures", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const item = await makeItem(makeInternalMcpCatalog, "with-tools");
    await makeTool({ name: "with-tools__a", catalogId: item.id });
    await makeTool({ name: "with-tools__b", catalogId: item.id });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${item.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toolCount: 2,
      skillCount: 0,
      imageApprovalRequired: false,
    });
    expect(response.json().effectiveActions).toContain("update");
  });

  test("McpServerModel.findAll narrows to catalogIds in SQL", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const a = await makeItem(makeInternalMcpCatalog, "a");
    const b = await makeItem(makeInternalMcpCatalog, "b");
    const serverA = await makeMcpServer({ catalogId: a.id, scope: "org" });
    await makeMcpServer({ catalogId: b.id, scope: "org" });

    const found = await McpServerModel.findAll(
      ctx.user.id,
      true,
      ctx.organizationId,
      undefined,
      true,
      { catalogIds: [a.id] },
    );

    expect(found.map((server) => server.id)).toEqual([serverA.id]);
  });

  test("McpServerModel.findAll shows a plain member the same installs with or without catalogIds", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const viewer = await makeUser();
    await makeMember(viewer.id, ctx.organizationId, { role: "member" });
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await TeamModel.addMember(team.id, viewer.id);
    const otherTeam = await makeTeam(ctx.organizationId, ctx.user.id);
    const item = await makeItem(makeInternalMcpCatalog, "shared");
    await makeMcpServer({ catalogId: item.id, scope: "org" });
    await makeMcpServer({ catalogId: item.id, scope: "team", teamId: team.id });
    await makeMcpServer({
      catalogId: item.id,
      scope: "team",
      teamId: otherTeam.id,
    });
    await makeMcpServer({
      catalogId: item.id,
      scope: "personal",
      ownerId: ctx.user.id,
    });
    const own = await makeMcpServer({
      catalogId: item.id,
      scope: "personal",
      ownerId: viewer.id,
    });
    await McpServerUserModel.assignUserToMcpServer(own.id, viewer.id);

    const list = (catalogIds?: string[]) =>
      McpServerModel.findAll(
        viewer.id,
        false,
        ctx.organizationId,
        undefined,
        false,
        catalogIds ? { catalogIds } : undefined,
      ).then((servers) => servers.map((server) => server.id).sort());

    const unfiltered = await list();
    expect(unfiltered).toHaveLength(3);
    expect(await list([item.id])).toEqual(unfiltered);
  });

  describe("server-side attention order", () => {
    test("ranks every issue kind, audience and mute as the browser's rule does over the issue index", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeTeam,
    }) => {
      const admin = ctx.user.id;
      const viewer = await makeUser();
      await makeMember(viewer.id, ctx.organizationId, { role: "member" });
      const team = await makeTeam(ctx.organizationId, admin);
      await TeamModel.addMember(team.id, viewer.id);
      const access = { users: [viewer.id] };
      const item = (name: string, serverType: "local" | "remote") =>
        makeItem(makeInternalMcpCatalog, name, { access, serverType });
      const personal = async (
        catalogId: string,
        overrides: Record<string, unknown> = {},
      ) => {
        const server = await makeMcpServer({
          catalogId,
          ownerId: viewer.id,
          scope: "personal",
          ...overrides,
        });
        await McpServerUserModel.assignUserToMcpServer(server.id, viewer.id);
        return server;
      };
      const oauthFailure = {
        oauthRefreshError: "refresh_failed" as const,
        oauthRefreshErrorMessage: "invalid_grant",
        oauthRefreshFailedAt: new Date("2026-09-01T00:00:00Z"),
      };

      const ownFailed = await item("a-own-failed", "local");
      await personal(ownFailed.id, { localInstallationStatus: "error" });
      const orgFailed = await item("b-org-failed", "local");
      await makeMcpServer({
        catalogId: orgFailed.id,
        ownerId: admin,
        scope: "org",
        localInstallationStatus: "error",
      });
      const ownReauth = await item("c-own-reauth", "remote");
      await personal(ownReauth.id, oauthFailure);
      const orgReauth = await item("d-org-reauth", "remote");
      await makeMcpServer({
        catalogId: orgReauth.id,
        ownerId: admin,
        scope: "org",
        ...oauthFailure,
      });
      const notRunning = await item("e-own-not-running", "local");
      const stopped = await personal(notRunning.id, {
        localInstallationStatus: "success",
      });
      const muted = await item("f-own-muted", "local");
      const mutedServer = await personal(muted.id, {
        localInstallationStatus: "error",
      });
      const healthy = await item("g-healthy", "local");
      const running = await personal(healthy.id, {
        localInstallationStatus: "success",
      });
      const teamReauth = await item("h-team-reauth", "remote");
      await makeMcpServer({
        catalogId: teamReauth.id,
        ownerId: admin,
        scope: "team",
        teamId: team.id,
        ...oauthFailure,
      });
      await McpServerAlertMuteModel.dismiss({
        userId: viewer.id,
        catalogId: muted.id,
        mcpServerId: mutedServer.id,
        issueKind: "failed-to-start",
        issueFingerprint: createMcpServerAlertFingerprint({
          kind: "failed-to-start",
          catalogId: muted.id,
          serverId: mutedServer.id,
          source: String(mutedServer.updatedAt.toISOString()),
        }),
        reason: "Known",
      });
      const runtime = (state: string) => ({
        state,
        message: state,
        error: null,
        serverName: "s",
        deploymentName: null,
        namespace: "default",
      });
      vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue(
        {
          status: "running",
          mcpServers: {
            [stopped.id]: runtime("failed"),
            [running.id]: runtime("running"),
          },
        } as never,
      );

      ctx.user = { ...ctx.user, id: viewer.id };
      const page = (await search({ sortBy: "attention" })) as RegistryPage & {
        attentionTiers?: string[][];
      };
      const index = (
        await ctx.app.inject({
          method: "GET",
          url: "/api/internal_mcp_catalog/registry/issue-index",
        })
      ).json();

      // The browser's side: the rule over the issue index as it arrives
      // (dates as strings, empty fields left out), the deployment feed's
      // projection of the same runtime summary, and the viewer's rights.
      const statuses: Record<string, McpDeploymentStatusEntry> = {};
      for (const server of index.servers) {
        const entry =
          McpServerRuntimeManager.statusSummary.mcpServers[server.id];
        statuses[server.id] = entry
          ? {
              state: entry.state,
              message: entry.message,
              error: entry.error,
              deploymentName: entry.deploymentName ?? undefined,
            }
          : {
              state: "not_created",
              message: "Deployment not created",
              error: null,
            };
      }
      const permissions = await UserModel.getUserPermissions(
        viewer.id,
        ctx.organizationId,
      );
      const isInstallsAdmin = await isMcpInstallationAdmin({
        userId: viewer.id,
        organizationId: ctx.organizationId,
      });
      const granted = (action: "create" | "update") =>
        isPermissionActionGranted({
          resource: "mcpServerInstallation",
          grantedActions: permissions.mcpServerInstallation ?? [],
          requiredAction: action,
        });
      const browserIssues = computeMcpServerIssues({
        items: index.catalogItems.map((entry: Record<string, unknown>) => ({
          dynamicConnectionMcpServerId: null,
          ...entry,
        })),
        servers: index.servers.map((entry: Record<string, unknown>) => ({
          ownerId: null,
          teamId: null,
          localInstallationError: null,
          oauthRefreshErrorMessage: null,
          oauthRefreshErrorDescription: null,
          oauthRefreshFailedAt: null,
          ...entry,
        })),
        deploymentStatuses: statuses,
        viewer: {
          userId: viewer.id,
          canManageInstalls: isInstallsAdmin,
          canReauthenticate: (server) =>
            canReauthenticateConnection({
              server,
              viewer: {
                userId: viewer.id,
                teamIds: new Set([team.id]),
                canCreate: granted("create"),
                canUpdate: granted("update"),
                isInstallsAdmin,
              },
            }),
        },
      });
      const browserTiers = attentionRankTiers(browserIssues);

      expect(page.attentionTiers).toEqual(browserTiers);
      // Every case lands somewhere specific: the viewer's own faults first,
      // somebody else's next, muted and healthy items unranked.
      expect(browserTiers[0]).toEqual(
        [ownFailed.id, ownReauth.id, notRunning.id].sort(),
      );
      expect(browserTiers[1]).toEqual(
        [orgFailed.id, orgReauth.id, teamReauth.id].sort(),
      );
      // Within a tier, by name.
      expect(names(page)).toEqual([
        "a-own-failed",
        "c-own-reauth",
        "e-own-not-running",
        "b-org-failed",
        "d-org-reauth",
        "h-team-reauth",
        "f-own-muted",
        "g-healthy",
      ]);
    });

    test("orders by the caller's tiers when it sends them, and echoes none", async ({
      makeInternalMcpCatalog,
    }) => {
      const first = await makeItem(makeInternalMcpCatalog, "first");
      const second = await makeItem(makeInternalMcpCatalog, "second");

      const page = (await search({
        sortBy: "attention",
        rankTiers: [[second.id], [first.id]],
      })) as RegistryPage & { attentionTiers?: string[][] };

      expect(names(page)).toEqual(["second", "first"]);
      expect(page.attentionTiers).toBeUndefined();
    });

    test("keeps one direction for the attention and issue age orders", async ({
      makeInternalMcpCatalog,
    }) => {
      const first = await makeItem(makeInternalMcpCatalog, "first");
      const second = await makeItem(makeInternalMcpCatalog, "second");
      const rankTiers = [[second.id], [first.id]];

      // The most urgent item comes first either way, as the sort menu offers.
      for (const sortBy of ["attention", "issueAge"]) {
        for (const sortDirection of ["asc", "desc"]) {
          expect(
            names(await search({ sortBy, sortDirection, rankTiers })),
          ).toEqual(["second", "first"]);
        }
      }
    });

    test("orders tiers by number, past ten tiers too", async ({
      makeInternalMcpCatalog,
    }) => {
      const items = [];
      for (let i = 0; i < 12; i++) {
        items.push(await makeItem(makeInternalMcpCatalog, `tier-${i}`));
      }
      // Reverse name order, so only the tier number can produce it.
      const ranked = [...items].reverse();

      const page = await search({
        sortBy: "attention",
        rankTiers: ranked.map((item) => [item.id]),
      });

      expect(names(page)).toEqual(ranked.map((item) => item.name));
    });
  });

  describe("server-side attention order inputs", () => {
    for (const status of ["not_initialized", "initializing"] as const)
      test(`classifies installs from their rows alone while the runtime is ${status}, as the browser's empty feed does`, async ({
        makeInternalMcpCatalog,
        makeMcpServer,
      }) => {
        const failed = await makeItem(makeInternalMcpCatalog, "failed", {
          serverType: "local",
        });
        await makeMcpServer({
          catalogId: failed.id,
          ownerId: ctx.user.id,
          scope: "org",
          localInstallationStatus: "error",
        });
        const healthy = await makeItem(makeInternalMcpCatalog, "healthy", {
          serverType: "local",
        });
        await makeMcpServer({
          catalogId: healthy.id,
          ownerId: ctx.user.id,
          scope: "org",
          localInstallationStatus: "success",
        });
        vi.spyOn(
          McpServerRuntimeManager,
          "statusSummary",
          "get",
        ).mockReturnValue({ status, mcpServers: {} } as never);

        const page = (await search({ sortBy: "attention" })) as RegistryPage & {
          attentionTiers?: string[][];
        };

        // A not-created deployment would flag the healthy install too.
        expect(page.attentionTiers).toEqual([[failed.id], []]);
      });

    test("re-authenticates through direct team memberships only, as the browser's teams list does", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeTeam,
      makeCustomRole,
    }) => {
      const role = await makeCustomRole(ctx.organizationId, {
        permission: {
          mcpRegistry: ["read"],
          mcpServerInstallation: ["read", "create", "update"],
        },
      });
      const viewer = await makeUser();
      await makeMember(viewer.id, ctx.organizationId, { role: role.role });
      const parent = await makeTeam(ctx.organizationId, ctx.user.id);
      const child = await makeTeam(ctx.organizationId, ctx.user.id, {
        parentId: parent.id,
      });
      await TeamModel.addMember(child.id, viewer.id);
      const item = await makeItem(makeInternalMcpCatalog, "parent-team-oauth", {
        serverType: "remote",
        access: { users: [viewer.id] },
      });
      await makeMcpServer({
        catalogId: item.id,
        ownerId: ctx.user.id,
        scope: "team",
        teamId: parent.id,
        ...{
          oauthRefreshError: "refresh_failed" as const,
          oauthRefreshFailedAt: new Date("2026-09-01T00:00:00Z"),
        },
      });

      ctx.user = { ...ctx.user, id: viewer.id };
      const page = (await search({ sortBy: "attention" })) as RegistryPage & {
        attentionTiers?: string[][];
      };

      // The browser's rule knows the viewer's own teams (the child), not the
      // parent that membership reaches: the connection is somebody else's to
      // re-authenticate, if it is listed at all.
      expect(page.attentionTiers?.[0]).toEqual([]);
    });

    test("refuses a request naming more catalog ids than one query can bind", async () => {
      const ids = Array.from({ length: 10_001 }, () => crypto.randomUUID());

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/registry/search",
        payload: {
          limit: 10,
          offset: 0,
          sortBy: "attention",
          rankTiers: [ids.slice(0, 5_000), ids.slice(5_000)],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("the deployment feed covers every local install the issue index lists, for every kind of viewer", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      makeMember,
      makeTeam,
    }) => {
      const member = await makeUser();
      await makeMember(member.id, ctx.organizationId, { role: "member" });
      const team = await makeTeam(ctx.organizationId, ctx.user.id);
      await TeamModel.addMember(team.id, member.id);
      const item = await makeItem(makeInternalMcpCatalog, "local-item", {
        serverType: "local",
      });
      await makeMcpServer({ catalogId: item.id, scope: "org" });
      await makeMcpServer({
        catalogId: item.id,
        scope: "team",
        teamId: team.id,
      });
      await makeMcpServer({
        catalogId: item.id,
        scope: "personal",
        ownerId: ctx.user.id,
      });
      const own = await makeMcpServer({
        catalogId: item.id,
        scope: "personal",
        ownerId: member.id,
      });
      await McpServerUserModel.assignUserToMcpServer(own.id, member.id);

      for (const viewer of [
        {
          userId: ctx.user.id,
          isMcpServerAdmin: true,
          isPredefinedAdmin: true,
        },
        {
          userId: ctx.user.id,
          isMcpServerAdmin: true,
          isPredefinedAdmin: false,
        },
        {
          userId: member.id,
          isMcpServerAdmin: false,
          isPredefinedAdmin: false,
        },
      ]) {
        const feed = await McpServerModel.findVisibleLocalIds({
          ...viewer,
          organizationId: ctx.organizationId,
        });
        const index = await McpServerModel.findIssueIndexRows({
          viewer: { ...viewer, canReadInstalls: true },
          organizationId: ctx.organizationId,
        });
        expect([...feed].sort()).toEqual(index.map((row) => row.id).sort());
      }
    });
  });
});
