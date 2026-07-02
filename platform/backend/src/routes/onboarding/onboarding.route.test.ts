import { UserOnboardingStepModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET/POST /api/onboarding/steps", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organizationId = (await makeOrganization()).id;
    user = await makeUser();
    actingUser = user;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("starts empty, then reflects a completed step", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/onboarding/steps",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ completedKeys: [] });

    const complete = await app.inject({
      method: "POST",
      url: "/api/onboarding/steps/complete",
      payload: { stepKey: "projects" },
    });
    expect(complete.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/onboarding/steps",
    });
    expect(after.json()).toEqual({ completedKeys: ["projects"] });
  });

  test("completing a step is idempotent", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/onboarding/steps/complete",
        payload: { stepKey: "mcp-registry" },
      });
      expect(res.statusCode).toBe(200);
    }
    const keys = await UserOnboardingStepModel.listCompletedKeys({
      userId: user.id,
    });
    expect(keys).toEqual(["mcp-registry"]);
  });

  test("progress is per-user", async ({ makeUser }) => {
    await app.inject({
      method: "POST",
      url: "/api/onboarding/steps/complete",
      payload: { stepKey: "projects" },
    });

    const other = await makeUser({ email: "onboarding-other@test.com" });
    actingUser = other;
    const res = await app.inject({
      method: "GET",
      url: "/api/onboarding/steps",
    });
    expect(res.json()).toEqual({ completedKeys: [] });
  });
});
