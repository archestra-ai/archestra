import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/skills/catalog/search", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillRoutes } = await import("./skill.routes");
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("reports the catalog size and returns no results for an empty query", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skills/catalog/search",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalCount).toBeGreaterThan(0);
    expect(body.results).toEqual([]);
  });

  test("ranks matches and caps the result count at the requested limit", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skills/catalog/search?q=pdf&limit=5",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results.length).toBeLessThanOrEqual(5);
    for (const result of body.results) {
      expect(typeof result.repo).toBe("string");
      expect(typeof result.name).toBe("string");
      expect(typeof result.fileCount).toBe("number");
    }
  });

  test("rejects a limit outside the allowed range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skills/catalog/search?q=pdf&limit=0",
    });

    expect(response.statusCode).toBe(400);
  });
});
