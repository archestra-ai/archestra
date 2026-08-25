import { OrganizationModel, SkillMarketplaceRepoModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillMarketplaceRoutes from "./skill-marketplace.routes";

describe("GET /api/skill-marketplace", () => {
  const ctx = useRouteTestApp(skillMarketplaceRoutes);

  test("returns the static clone URL and the derived marketplace name", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skill-marketplace",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cloneUrl).toMatch(/\/skills\/marketplace\.git$/);
    expect(body.marketplaceName).toMatch(/-skills$/);
    expect(body.requiresAuthentication).toBe(true);
  });

  test("keeps the name frozen on the caller's existing repo", async () => {
    await SkillMarketplaceRepoModel.ensureForViewer({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      marketplaceName: "archestra-old-name-skills",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skill-marketplace",
    });

    // the client registered the marketplace under the frozen name, so the
    // install commands must keep naming it
    expect(response.json().marketplaceName).toBe("archestra-old-name-skills");
  });

  test("reports that no credential is needed when the org publishes anonymously", async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      skillMarketplaceAnonymousAccess: true,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skill-marketplace",
    });

    expect(response.json().requiresAuthentication).toBe(false);
  });

  test("names the shared repo, not the caller's, when clones are anonymous", async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      skillMarketplaceAnonymousAccess: true,
    });
    await SkillMarketplaceRepoModel.ensureForViewer({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      marketplaceName: "archestra-my-own-skills",
    });
    await SkillMarketplaceRepoModel.ensureForViewer({
      organizationId: ctx.organizationId,
      userId: null,
      marketplaceName: "archestra-shared-skills",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/skill-marketplace",
    });

    // a credential-less clone lands on the org's shared repo, so the install
    // commands must name that plugin
    expect(response.json().marketplaceName).toBe("archestra-shared-skills");
  });
});
