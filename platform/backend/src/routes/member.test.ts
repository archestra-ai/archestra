import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("member routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: memberRoutes } = await import("./member");
    await app.register(memberRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns paginated members for the current organization", async ({
    makeMember,
    makeUser,
  }) => {
    const alpha = await makeUser({ name: "Alpha Example" });
    const beta = await makeUser({ name: "Beta Example" });
    await makeMember(alpha.id, organizationId, { role: "member" });
    await makeMember(beta.id, organizationId, { role: "editor" });

    const response = await app.inject({
      method: "GET",
      url: "/api/members?limit=2&offset=0",
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      pagination: {
        currentPage: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
      },
    });
    expect(payload.data).toHaveLength(2);
    expect(payload.data[0]?.name).toContain("Admin User");
    expect(payload.data[1]?.name).toBe("Alpha Example");
  });

  test("filters members by name or email and role", async ({
    makeMember,
    makeUser,
  }) => {
    const targetUser = await makeUser({
      name: "Gamma Searchable",
      email: "gamma@example.com",
    });
    const otherUser = await makeUser({
      name: "Delta Searchable",
      email: "delta@example.com",
    });
    await makeMember(targetUser.id, organizationId, { role: "member" });
    await makeMember(otherUser.id, organizationId, { role: "editor" });

    const response = await app.inject({
      method: "GET",
      url: "/api/members?limit=10&offset=0&name=gamma&role=member",
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      data: [
        {
          name: "Gamma Searchable",
          email: "gamma@example.com",
          role: "member",
        },
      ],
      pagination: {
        total: 1,
        hasNext: false,
        hasPrev: false,
      },
    });
  });
});
