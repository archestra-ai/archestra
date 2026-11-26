import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { OrganizationModel } from "@/models";
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
  });

  test.each([
    "a",
    "an",
    "the",
    "of",
  ])("answers the common word %j with skills that start with it", async (word) => {
    // These are stop words the index leaves out, and each is also how a
    // longer word starts ("the" → "theme"). They used to return nothing.
    const response = await app.inject({
      method: "GET",
      url: `/api/skills/catalog/search?q=${word}`,
    });

    expect(response.statusCode).toBe(200);
    const { results } = response.json() as {
      results: Array<{
        name: string;
        repo: string;
        skillPath: string;
        description: string;
      }>;
    };
    expect(results.length).toBeGreaterThan(0);
    // Every result holds a word that starts with what was typed.
    const startsWithWord = new RegExp(`(^|[^a-z0-9])${word}[a-z0-9]`, "i");
    for (const result of results) {
      expect(
        [result.name, result.repo, result.skillPath, result.description].join(
          "\n",
        ),
      ).toMatch(startsWithWord);
    }
  });

  test("403s when the org has disabled the online skill catalog", async () => {
    await OrganizationModel.patch(organizationId, {
      onlineSkillCatalogEnabled: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skills/catalog/search?q=pdf",
    });

    expect(response.statusCode).toBe(403);
  });

  test("rejects a limit outside the allowed range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skills/catalog/search?q=pdf&limit=0",
    });

    expect(response.statusCode).toBe(400);
  });
});
