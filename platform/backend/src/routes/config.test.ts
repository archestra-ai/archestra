import { fastifyAuthPlugin } from "@/auth";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

describe("config routes", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    app = createFastifyInstance();
    await app.register(fastifyAuthPlugin);

    const { default: configRoutes } = await import("./config");
    await app.register(configRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns public config without authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/config/public",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      disableBasicAuth: expect.any(Boolean),
      disableInvitations: expect.any(Boolean),
    });
  });
});
