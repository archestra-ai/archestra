import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/projects", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates the project", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "research", description: "things" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      name: string;
      isOwner: boolean;
    }>();
    expect(body).toMatchObject({
      name: "research",
      isOwner: true,
      conversationCount: 0,
      visibility: null,
    });
  });

  test("rejects invalid names with 400 and duplicates with 409", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "a/b" },
    });
    expect(bad.statusCode).toBe(400);

    const first = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dup" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dup" },
    });
    expect(second.statusCode).toBe(409);
  });
});
