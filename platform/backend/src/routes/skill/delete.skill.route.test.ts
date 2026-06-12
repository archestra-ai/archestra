import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const MANIFEST = [
  "---",
  "name: pdf-processing",
  "description: Extract text from PDF files.",
  "---",
  "",
  "# PDF Processing",
  "Use pdftotext -layout.",
].join("\n");

describe("DELETE /api/skills/:id", () => {
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

  test("deletes a skill", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/skills/${created.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/skills/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
  });
});
