import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { hasPermissionMock } = vi.hoisted(() => ({
  hasPermissionMock: vi.fn(),
}));

vi.mock("@/auth", async () => {
  const actual = await vi.importActual<typeof import("@/auth")>("@/auth");
  return {
    ...actual,
    hasPermission: hasPermissionMock,
  };
});

describe("team members route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });

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

    const { default: teamRoutes } = await import("./team");
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns hydrated team members with user details", async ({
    makeTeam,
    makeUser,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const member = await makeUser({
      name: "Hydrated Member",
      email: "hydrated@example.com",
    });

    const { TeamModel } = await import("@/models");
    await TeamModel.addMember(team.id, member.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/members`,
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload).toEqual([
      expect.objectContaining({
        userId: member.id,
        name: "Hydrated Member",
        email: "hydrated@example.com",
      }),
    ]);
  });
});
