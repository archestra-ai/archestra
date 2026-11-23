import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { OrganizationModel } from "@/models";
import { telemetryPreference } from "@/observability/telemetry-preference";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("first-run setup", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    // Restored automatically after each test by the shared setup. Analytics
    // defaults off outside production, and the dialog respects that opt-out.
    config.enterpriseFeatures.core = false;
    config.analytics.enabled = true;

    const organization = await makeOrganization();
    organizationId = organization.id;
    const user = await makeUser();

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

  async function shouldShow() {
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/first-run-setup",
    });
    expect(response.statusCode).toBe(200);
    return response.json().show as boolean;
  }

  function complete(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/onboarding/first-run-setup",
      payload,
    });
  }

  describe("GET /api/onboarding/first-run-setup", () => {
    test("shown on a new unlicensed installation", async () => {
      expect(await shouldShow()).toBe(true);
    });

    test("not shown with an enterprise license", async () => {
      config.enterpriseFeatures.core = true;
      expect(await shouldShow()).toBe(false);
    });

    test("not shown when the deployment turned analytics off", async () => {
      config.analytics.enabled = false;
      expect(await shouldShow()).toBe(false);
    });

    test("not shown again once finished", async () => {
      await complete({ telemetryEnabled: true });
      expect(await shouldShow()).toBe(false);
    });
  });

  describe("POST /api/onboarding/first-run-setup", () => {
    test("keeps telemetry on and records the organization as done", async () => {
      const response = await complete({ telemetryEnabled: true });

      expect(response.statusCode).toBe(200);
      expect(await telemetryPreference.isEnabled()).toBe(true);
      const organization = await OrganizationModel.getById(organizationId);
      expect(organization?.firstRunSetupCompletedAt).not.toBeNull();
    });

    test("turning telemetry off stops it for the instance", async () => {
      expect(await telemetryPreference.isEnabled()).toBe(true);

      await complete({ telemetryEnabled: false });

      expect(await telemetryPreference.isEnabled()).toBe(false);
      // Other replicas read the choice from the database.
      telemetryPreference.clear();
      expect(await telemetryPreference.isEnabled()).toBe(false);
    });

    test("a second submission does not change the first choice", async () => {
      await complete({ telemetryEnabled: false });

      const response = await complete({ telemetryEnabled: true });

      expect(response.statusCode).toBe(200);
      telemetryPreference.clear();
      expect(await telemetryPreference.isEnabled()).toBe(false);
    });

    test("rejects a body without the telemetry choice", async () => {
      const response = await complete({});

      expect(response.statusCode).toBe(400);
      expect(await shouldShow()).toBe(true);
    });
  });
});
