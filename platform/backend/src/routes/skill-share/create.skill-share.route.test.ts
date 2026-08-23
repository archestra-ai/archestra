import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AuditLogModel, PluginModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  useRouteTestApp,
} from "@/test";
import type { ClientType, User } from "@/types";
import skillShareRoutes, { deriveMarketplaceName } from "./skill-share.routes";
import { seedSkill } from "./skill-share.test-helpers";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

describe("POST /api/skill-share-links", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("admin can create a share link and receives the raw token once", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "alpha",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [skill.id], name: "Demo" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.rawToken).toBe("string");
    expect(body.rawToken).toMatch(/^archestra_skl_/);
    // <app>-<org>-skills; "archestra" is the default app slug, org slug
    // is whatever the test fixture stamped on the organization row.
    expect(body.marketplaceName).toMatch(/^archestra-[a-z0-9-]+-skills$/);
    expect(body.cloneUrl).toContain(`/skills/m/${body.rawToken}/repo.git`);
    expect(body.link.status).toBe("active");
    expect(body.link.skills).toHaveLength(1);
    expect(body.link.skills[0].id).toBe(skill.id);
    expect(body.link.tokenStart).toBe(body.rawToken.slice(0, 22));
    // tokenHash must never leak to the response
    expect(body.link).not.toHaveProperty("tokenHash");
  });

  test("member without admin role gets 403", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: MEMBER_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "beta",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [skill.id] },
    });

    expect(response.statusCode).toBe(403);
  });

  test("creating a share for a skill in another org returns 404", async ({
    makeMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const otherOrg = await makeOrganization();
    const otherSkill = await seedSkill({
      organizationId: otherOrg.id,
      name: "foreign",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [otherSkill.id] },
    });

    expect(response.statusCode).toBe(404);
  });

  test("expiresAt is honored and a far-past value classifies the link as expired", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const skill = await seedSkill({
      organizationId: ctx.organizationId,
      name: "ttl",
    });

    const expired = new Date(Date.now() - 60_000).toISOString();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [skill.id], expiresAt: expired },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.link.status).toBe("expired");
  });

  test("rejects an empty skillIds list", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  test("caps derived marketplace names at the shared client limit", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization({
      name: "Very Long Organization Name ".repeat(8),
      slug: "very-long-organization-slug-".repeat(8),
    });
    expect(
      (await deriveMarketplaceName(organization.id)).length,
    ).toBeLessThanOrEqual(64);
  });

  test("creates a plugin-only expiring marketplace for one client type", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const plugin = await seedPlugin("claude-code");

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: {
        skillIds: [],
        pluginIds: [plugin.id],
        pluginPlatform: "posix",
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().marketplaceName).toMatch(
      /^archestra-[a-z0-9-]+-plugins$/,
    );
    expect(response.json().link).toMatchObject({
      pluginClientType: "claude-code",
      skills: [],
      plugins: [
        expect.objectContaining({
          id: plugin.id,
          pluginSlug: plugin.pluginSlug,
        }),
      ],
    });
  });

  test("plugin links require expiry and reject mixed client types", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const claude = await seedPlugin("claude-code");
    const codex = await seedPlugin("codex");

    const noExpiry = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: {
        skillIds: [],
        pluginIds: [claude.id],
        pluginPlatform: "posix",
      },
    });
    expect(noExpiry.statusCode).toBe(400);

    const mixed = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: {
        skillIds: [],
        pluginIds: [claude.id, codex.id],
        pluginPlatform: "posix",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(mixed.statusCode).toBe(400);
  });

  test("plugin links require a compatible target platform", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const plugin = await seedPlugin("claude-code");
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const missingPlatform = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: { skillIds: [], pluginIds: [plugin.id], expiresAt },
    });
    expect(missingPlatform.statusCode).toBe(400);

    const incompatiblePlatform = await ctx.app.inject({
      method: "POST",
      url: "/api/skill-share-links",
      payload: {
        skillIds: [],
        pluginIds: [plugin.id],
        pluginPlatform: "windows",
        expiresAt,
      },
    });
    expect(incompatiblePlatform.statusCode).toBe(400);
  });

  async function seedPlugin(clientType: ClientType) {
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: `${clientType} plugin`,
        description: "test hook",
        clientType,
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    return plugin;
  }
});

describe("marketplace share-link audit records", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    const actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = actor;
    });
    registerAuditLogHook(app);
    await app.register(skillShareRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("create, rotate, and revoke audit the bearer capability without secrets", async () => {
    const skill = await seedSkill({ organizationId, name: "audited-share" });
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: { skillIds: [skill.id] },
      })
    ).json();
    const rotated = (
      await app.inject({
        method: "POST",
        url: `/api/skill-share-links/${created.link.id}/rotate`,
        payload: {},
      })
    ).json();
    await app.inject({
      method: "DELETE",
      url: `/api/skill-share-links/${rotated.link.id}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "skillShareLink",
      sortDirection: "asc",
      limit: 20,
      offset: 0,
    });
    expect(data.map((row) => row.action)).toEqual([
      "skillShareLink.created",
      "skillShareLink.rotated",
      "skillShareLink.revoked",
    ]);
    expect(data[0].after).toMatchObject({
      id: created.link.id,
      skills: [expect.objectContaining({ id: skill.id })],
    });
    expect(data[1].before).toMatchObject({ revokedAt: null });
    expect(data[1].after).toMatchObject({
      revoked: { id: created.link.id },
      replacement: { id: rotated.link.id, revokedAt: null },
    });
    expect(data[1].after).not.toMatchObject({
      revoked: { revokedAt: null },
    });
    expect(data[2].before).toMatchObject({
      id: rotated.link.id,
      revokedAt: null,
    });
    for (const row of data) {
      const snapshot = JSON.stringify({ before: row.before, after: row.after });
      expect(snapshot).not.toContain("rawToken");
      expect(snapshot).not.toContain("tokenHash");
      expect(snapshot).not.toContain(created.rawToken);
      expect(snapshot).not.toContain(rotated.rawToken);
    }
  });
});
