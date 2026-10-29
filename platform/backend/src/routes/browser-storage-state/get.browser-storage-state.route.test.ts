import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { BrowserStorageStateModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/browser-storage-states", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: admin, organizationId });
    });
    const { default: routes } = await import("./browser-storage-state.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists members' saved logins as counts, never cookies", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser({ name: "Saved Member" });
    await makeMember(member.id, organizationId);
    await BrowserStorageStateModel.upsert(
      member.id,
      JSON.stringify({
        cookies: [
          { name: "sid", value: "secret-cookie", domain: ".example.com" },
          { name: "pref", value: "x", domain: "example.com" },
          { name: "sid", value: "y", domain: "app.example.org" },
        ],
        origins: [
          { origin: "https://app.example.org", localStorage: [] },
          { origin: "https://docs.example.net", localStorage: [] },
        ],
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/browser-storage-states",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        userId: member.id,
        name: "Saved Member",
        siteCount: 3,
      }),
    ]);
    expect(response.body).not.toContain("secret-cookie");
    expect(response.body).not.toContain("example.com");
  });

  test("leaves out users of other organizations", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const outsider = await makeUser();
    await makeMember(outsider.id, (await makeOrganization()).id);
    await BrowserStorageStateModel.upsert(outsider.id, "{}");

    const response = await app.inject({
      method: "GET",
      url: "/api/browser-storage-states",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
