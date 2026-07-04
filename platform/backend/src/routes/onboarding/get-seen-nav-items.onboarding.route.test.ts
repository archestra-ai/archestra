import { UserOnboardingSeenItemModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/onboarding/seen-nav-items", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns an empty list for a user with no seen items", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/seen-nav-items",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  test("returns the user's seen items", async () => {
    await UserOnboardingSeenItemModel.markSeen({
      userId: user.id,
      items: ["nav:projects", "nav:apps"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/seen-nav-items",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.sort()).toEqual(["nav:apps", "nav:projects"]);
  });

  test("does not leak another user's seen items", async ({ makeUser }) => {
    const otherUser = await makeUser();
    await UserOnboardingSeenItemModel.markSeen({
      userId: otherUser.id,
      items: ["nav:projects"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/seen-nav-items",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });
});
