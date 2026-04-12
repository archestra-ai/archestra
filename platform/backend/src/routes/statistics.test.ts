import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("statistics routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: statisticsRoutes } = await import("./statistics");
    await app.register(statisticsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/statistics/cost-health", () => {
    test("returns valid cost health response", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/cost-health",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();

      expect(body).toHaveProperty("score");
      expect(body.score).toBeGreaterThanOrEqual(0);
      expect(body.score).toBeLessThanOrEqual(100);

      for (const key of [
        "limits",
        "optimizationRules",
        "compression",
        "toolHygiene",
      ]) {
        const dimension = body.dimensions[key];
        expect(typeof dimension.score).toBe("number");
        expect(["low", "moderate", "high"]).toContain(dimension.severity);
        expect(typeof dimension.message).toBe("string");
        expect(typeof dimension.link).toBe("string");
      }
    });
  });
});
