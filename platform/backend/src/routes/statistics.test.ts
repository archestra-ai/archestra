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
    test("returns 200 with valid health score shape", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/cost-health",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body).toHaveProperty("score");
      expect(body).toHaveProperty("dimensions");
      expect(body.dimensions).toHaveProperty("limits");
      expect(body.dimensions).toHaveProperty("optimizationRules");
      expect(body.dimensions).toHaveProperty("compression");
      expect(body.dimensions).toHaveProperty("toolHygiene");
    });

    test("each dimension has score, severity, message, and link", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/cost-health",
      });

      const body = response.json();

      for (const key of [
        "limits",
        "optimizationRules",
        "compression",
        "toolHygiene",
      ]) {
        const dimension = body.dimensions[key];
        expect(dimension).toHaveProperty("score");
        expect(dimension).toHaveProperty("severity");
        expect(dimension).toHaveProperty("message");
        expect(dimension).toHaveProperty("link");
        expect(typeof dimension.score).toBe("number");
        expect(["low", "moderate", "high"]).toContain(dimension.severity);
      }
    });

    test("overall score is between 0 and 100", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/statistics/cost-health",
      });

      const body = response.json();
      expect(body.score).toBeGreaterThanOrEqual(0);
      expect(body.score).toBeLessThanOrEqual(100);
    });
  });
});
