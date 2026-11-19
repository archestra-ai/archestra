import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { disconnectReferenceInText } from "@/services/connection-disconnect-reference";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/connected-clients/disconnect-reference", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let authMethod: "session" | "api_key" | "service_account";

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    authMethod = "session";

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user, authMethod });
    });
    const { default: routes } = await import("./connected-client.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const get = () =>
    app.inject({
      method: "GET",
      url: "/api/connected-clients/disconnect-reference",
    });

  test("a signed-in browser session gets a reference that is its own and is not cached", async ({
    makeUser,
  }) => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { reference, expiresAt } = response.json();
    const scope = { organizationId, secret: config.auth.secret };
    expect(
      disconnectReferenceInText({ ...scope, userId: user.id, text: reference }),
    ).toEqual({ reference, expiresAt: Date.parse(expiresAt) });
    const other = await makeUser();
    expect(
      disconnectReferenceInText({
        ...scope,
        userId: other.id,
        text: reference,
      }),
    ).toBeUndefined();
  });

  test("an API key or a service account cannot exempt a conversation", async () => {
    for (const method of ["api_key", "service_account"] as const) {
      authMethod = method;
      const response = await get();
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("cdr1_");
    }
  });
});
