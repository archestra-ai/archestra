import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("bootstrap route", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: "member" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      const req = request as typeof request & {
        user: User;
        organizationId: string;
      };
      req.user = user;
      req.organizationId = organization.id;
    });

    const [bootstrap, config, user_, organization_, resourcePermissions] =
      await Promise.all([
        import("./bootstrap"),
        import("./config"),
        import("./user"),
        import("./organization"),
        import("./resource-permission/resource-permission.routes"),
      ]);
    await app.register(bootstrap.default);
    await app.register(config.default);
    await app.register(user_.default);
    await app.register(organization_.default);
    await app.register(resourcePermissions.default);
  });

  afterEach(async () => {
    await app.close();
  });

  // The frontend seeds each part into the query its own endpoint feeds, so the
  // parts must be exactly what those endpoints return.
  test("returns the same data as the individual endpoints", async () => {
    const get = async (url: string) => {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      return response.json();
    };

    const bootstrap = await get("/api/bootstrap");

    expect(bootstrap).toEqual({
      permissions: await get("/api/user/permissions"),
      scopedCapabilities: await get("/api/resource-permissions"),
      organization: await get("/api/organization"),
      config: await get("/api/config"),
    });
    expect(Object.keys(bootstrap.permissions).length).toBeGreaterThan(0);
  });
});
