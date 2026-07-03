import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/onboarding/seen-nav-items", () => {
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

  test("marks items and returns the full seen list", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload: { items: ["nav:projects"] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ items: ["nav:projects"] });

    const second = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload: { items: ["nav:apps"] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.sort()).toEqual(["nav:apps", "nav:projects"]);
  });

  test("is idempotent for already-seen items", async () => {
    const payload = { items: ["nav:projects", "nav:projects"] };

    const first = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ items: ["nav:projects"] });
  });

  test("rejects an empty items array", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload: { items: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  test("rejects empty-string items", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/seen-nav-items",
      payload: { items: [""] },
    });
    expect(response.statusCode).toBe(400);
  });
});
