import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { OrganizationModel } from "@/models";
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

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: {
        ...actual.default.enterpriseFeatures,
        core: true,
      },
    },
  };
});

describe("team route TOON compression contract", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = adminUser;
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
    vi.restoreAllMocks();
    await app.close();
  });

  describe("POST /api/teams", () => {
    test("persists convertToolResultsToToon=true when org scope is 'team'", async () => {
      await OrganizationModel.patch(organizationId, {
        compressionScope: "team",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "Team With TOON",
          convertToolResultsToToon: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.convertToolResultsToToon).toBe(true);
    });

    test("rejects convertToolResultsToToon=true with 400 when org scope is 'organization'", async () => {
      // Default compressionScope is 'organization' — no patch needed.
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "Mismatched TOON",
          convertToolResultsToToon: true,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toMatch(
        /requires organization\.compressionScope to be "team"/,
      );
    });

    test("accepts omitted convertToolResultsToToon and defaults to false", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: { name: "No TOON Field" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.convertToolResultsToToon).toBe(false);
    });

    test("accepts convertToolResultsToToon=false regardless of org scope", async () => {
      // No-op declaration of the default — must not be rejected.
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "Explicit False TOON",
          convertToolResultsToToon: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.convertToolResultsToToon).toBe(false);
    });
  });

  describe("PUT /api/teams/:id", () => {
    test("rejects convertToolResultsToToon=true with 400 when org scope is 'organization'", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { convertToolResultsToToon: true },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toMatch(
        /requires organization\.compressionScope to be "team"/,
      );
    });

    test("persists convertToolResultsToToon=true when org scope is 'team'", async ({
      makeTeam,
    }) => {
      await OrganizationModel.patch(organizationId, {
        compressionScope: "team",
      });
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { convertToolResultsToToon: true },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.convertToolResultsToToon).toBe(true);
    });
  });
});
