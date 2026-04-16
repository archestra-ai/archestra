import { ARCHESTRA_TOKEN_PREFIX } from "@shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("user token routes", () => {
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

    const { default: userTokenRoutes } = await import("./user-token");
    await app.register(userTokenRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a personal token on first read and reuses it on subsequent reads", async () => {
    const firstResponse = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me",
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()).toMatchObject({
      id: expect.any(String),
      name: "Personal Token",
      tokenStart: expect.stringMatching(
        new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}`),
      ),
      createdAt: expect.any(String),
    });

    const secondResponse = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me",
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      id: firstResponse.json().id,
      tokenStart: firstResponse.json().tokenStart,
    });
  });

  test("returns the token value after creation", async () => {
    await app.inject({
      method: "GET",
      url: "/api/user-tokens/me",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me/value",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      value: expect.stringMatching(
        new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}[a-f0-9]{32}$`),
      ),
    });
  });

  test("returns 404 when reading token value before a token exists", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me/value",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Personal token not found");
  });

  test("rotates an existing token and returns the new value", async () => {
    const createResponse = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me",
    });

    const initialToken = createResponse.json();
    const initialValueResponse = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me/value",
    });
    const initialValue = initialValueResponse.json().value;

    const rotateResponse = await app.inject({
      method: "POST",
      url: "/api/user-tokens/me/rotate",
    });

    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json()).toMatchObject({
      id: initialToken.id,
      name: "Personal Token",
      tokenStart: expect.stringMatching(
        new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}`),
      ),
      value: expect.stringMatching(
        new RegExp(`^${ARCHESTRA_TOKEN_PREFIX}[a-f0-9]{32}$`),
      ),
    });
    expect(rotateResponse.json().value).not.toBe(initialValue);
    expect(rotateResponse.json().tokenStart).toBe(
      rotateResponse.json().value.substring(0, 14),
    );

    const updatedValueResponse = await app.inject({
      method: "GET",
      url: "/api/user-tokens/me/value",
    });

    expect(updatedValueResponse.statusCode).toBe(200);
    expect(updatedValueResponse.json().value).toBe(rotateResponse.json().value);
  });

  test("returns 404 when rotating before a token exists", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/user-tokens/me/rotate",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("Personal token not found");
  });
});
