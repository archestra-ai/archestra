import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
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

type LabelInput = { key: string; value: string };

describe("team label routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  const buildApp = (user: User) => {
    const instance = createFastifyInstance();
    instance.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: unknown; organizationId: string }
      ).user = user;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });
    return instance;
  };

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = buildApp(adminUser);
    const { default: teamRoutes } = await import("./team");
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createTeam = async (name: string, labels?: LabelInput[]) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name, labels },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  describe("create / read", () => {
    test("creates a team with labels and returns them", async () => {
      const team = await createTeam("Engineering", [
        { key: "env", value: "prod" },
        { key: "tier", value: "backend" },
      ]);

      expect(team.labels).toHaveLength(2);
      const pairs = team.labels.map((l: LabelInput) => `${l.key}=${l.value}`);
      expect(pairs).toContain("env=prod");
      expect(pairs).toContain("tier=backend");

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}`,
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().labels).toHaveLength(2);
    });

    test("a team created without labels has an empty labels array", async () => {
      const team = await createTeam("No Labels");
      expect(team.labels).toEqual([]);
    });
  });

  describe("update", () => {
    test("replaces labels when provided", async () => {
      const team = await createTeam("Team", [{ key: "env", value: "staging" }]);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { labels: [{ key: "env", value: "prod" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().labels).toEqual([
        expect.objectContaining({ key: "env", value: "prod" }),
      ]);
    });

    test("leaves labels untouched when omitted", async () => {
      const team = await createTeam("Team", [{ key: "env", value: "prod" }]);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { description: "renamed" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().labels).toHaveLength(1);
    });

    test("clears labels when an empty array is provided", async () => {
      const team = await createTeam("Team", [{ key: "env", value: "prod" }]);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { labels: [] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().labels).toEqual([]);
    });
  });

  describe("list filtering by labels", () => {
    test("filters with AND across keys and OR within values", async () => {
      await createTeam("prod-backend", [
        { key: "env", value: "prod" },
        { key: "tier", value: "backend" },
      ]);
      await createTeam("prod-frontend", [
        { key: "env", value: "prod" },
        { key: "tier", value: "frontend" },
      ]);
      await createTeam("staging-backend", [
        { key: "env", value: "staging" },
        { key: "tier", value: "backend" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: "/api/teams?labels=env:prod;tier:backend|frontend",
      });
      expect(response.statusCode).toBe(200);
      const names = response
        .json()
        .data.map((t: { name: string }) => t.name)
        .sort();
      expect(names).toEqual(["prod-backend", "prod-frontend"]);
    });

    test("returns no teams when the filter matches nothing", async () => {
      await createTeam("only-team", [{ key: "env", value: "prod" }]);

      const response = await app.inject({
        method: "GET",
        url: "/api/teams?labels=env:nonexistent",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });
  });

  describe("label keys/values endpoints", () => {
    test("returns team label keys and values scoped to teams", async () => {
      await createTeam("Team", [
        { key: "env", value: "prod" },
        { key: "region", value: "us-east-1" },
      ]);

      const keysResponse = await app.inject({
        method: "GET",
        url: "/api/teams/labels/keys",
      });
      expect(keysResponse.statusCode).toBe(200);
      expect(keysResponse.json()).toEqual(["env", "region"]);

      const valuesResponse = await app.inject({
        method: "GET",
        url: "/api/teams/labels/values?key=env",
      });
      expect(valuesResponse.statusCode).toBe(200);
      expect(valuesResponse.json()).toEqual(["prod"]);

      const allValuesResponse = await app.inject({
        method: "GET",
        url: "/api/teams/labels/values",
      });
      expect(allValuesResponse.statusCode).toBe(200);
      expect(allValuesResponse.json()).toEqual(["prod", "us-east-1"]);
    });

    test("a member without team-management permission can still read keys", async ({
      makeUser,
      makeMember,
    }) => {
      await createTeam("Team", [{ key: "env", value: "prod" }]);

      const memberUser = await makeUser({ email: "reader@test.com" });
      await makeMember(memberUser.id, organizationId);

      const memberApp = buildApp(memberUser);
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);
      // Member lacks organization-level team-management permission.
      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "GET",
        url: "/api/teams/labels/keys",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toContain("env");

      await memberApp.close();
    });
  });
});
