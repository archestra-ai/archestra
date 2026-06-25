import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The project plugin early-returns when projects is off, so none of its
// endpoints register and every project URL 404s. The flag is read at plugin
// registration time, so flip it before `app.register`.
describe("project routes are not served when projects is off", () => {
  let app: FastifyInstanceWithZod;
  const original = config.projects.enabled;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    (config.projects as { enabled: boolean }).enabled = false;
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();

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
    (config.projects as { enabled: boolean }).enabled = original;
  });

  test("GET /api/projects 404s", async () => {
    const response = await app.inject({ method: "GET", url: "/api/projects" });
    expect(response.statusCode).toBe(404);
  });

  test("POST /api/projects 404s", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  test("GET /api/projects/:id/instructions 404s", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/instructions",
    });
    expect(response.statusCode).toBe(404);
  });
});
