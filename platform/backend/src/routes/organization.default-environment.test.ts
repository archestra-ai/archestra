import type { RouteId } from "@shared";
import { requiredEndpointPermissionsMap } from "@shared/access-control";
import { type Mock, vi } from "vitest";
import OrganizationModel from "@/models/organization";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { createNetworkPolicy } from "@/services/environments/network-policy";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

// Mirrors the harness in environment.test.ts: the route plugin is registered on
// its own, with `user`/`organizationId` injected via an onRequest hook and
// `hasPermission` mocked. To exercise the real route -> permission map wiring
// (and a genuine 403 for a non-permitted member), the hook replicates the
// middleware's authorization gate using the actual requiredEndpointPermissionsMap.
vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

async function buildApp(user: User, organizationId: string) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: unknown }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;

    const routeId = request.routeOptions.schema?.operationId as
      | RouteId
      | undefined;
    const requiredPermissions = routeId
      ? requiredEndpointPermissionsMap[routeId]
      : undefined;
    if (requiredPermissions && Object.keys(requiredPermissions).length > 0) {
      const result = await hasPermission(requiredPermissions, request.headers);
      if (!result.success) {
        throw new ApiError(403, "Forbidden");
      }
    }
  });

  const { default: organizationRoutes } = await import("./organization");
  await app.register(organizationRoutes);
  return app;
}

describe("PATCH /api/organization/default-environment", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("admin can set both name and namespace", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: {
        name: "Primary",
        description: "Primary deployment target",
        namespace: "primary-ns",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultEnvironmentName).toBe("Primary");
    expect(res.json().defaultEnvironmentDescription).toBe(
      "Primary deployment target",
    );
    expect(res.json().defaultEnvironmentNamespace).toBe("primary-ns");

    // Re-fetch the org to confirm all fields persisted.
    const reloaded = await OrganizationModel.getById(organizationId);
    expect(reloaded?.defaultEnvironmentName).toBe("Primary");
    expect(reloaded?.defaultEnvironmentDescription).toBe(
      "Primary deployment target",
    );
    expect(reloaded?.defaultEnvironmentNamespace).toBe("primary-ns");
  });

  test("omitting a field leaves it unchanged", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    // Seed both fields.
    const setBoth = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Primary", namespace: "primary-ns" },
    });
    expect(setBoth.statusCode).toBe(200);

    // PATCH only name; namespace must be preserved.
    const updateName = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Renamed" },
    });
    expect(updateName.statusCode).toBe(200);
    expect(updateName.json().defaultEnvironmentName).toBe("Renamed");
    expect(updateName.json().defaultEnvironmentNamespace).toBe("primary-ns");

    // PATCH only namespace; name must be preserved.
    const updateNamespace = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { namespace: "renamed-ns" },
    });
    expect(updateNamespace.statusCode).toBe(200);
    expect(updateNamespace.json().defaultEnvironmentName).toBe("Renamed");
    expect(updateNamespace.json().defaultEnvironmentNamespace).toBe(
      "renamed-ns",
    );
  });

  test("persists description and leaves it unchanged when omitted", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    // Set the description.
    const setDescription = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { description: "Default target" },
    });
    expect(setDescription.statusCode).toBe(200);
    expect(setDescription.json().defaultEnvironmentDescription).toBe(
      "Default target",
    );

    // PATCH only name; description must be preserved.
    const updateName = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Renamed" },
    });
    expect(updateName.statusCode).toBe(200);
    expect(updateName.json().defaultEnvironmentName).toBe("Renamed");
    expect(updateName.json().defaultEnvironmentDescription).toBe(
      "Default target",
    );

    // Explicit null clears it.
    const clearDescription = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { description: null },
    });
    expect(clearDescription.statusCode).toBe(200);
    expect(clearDescription.json().defaultEnvironmentDescription).toBeNull();
  });

  test("explicit null clears a field", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Primary", namespace: "primary-ns" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { namespace: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultEnvironmentName).toBe("Primary");
    expect(res.json().defaultEnvironmentNamespace).toBeNull();
  });

  test("persists restricted and leaves it unchanged when omitted", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    // Defaults to false.
    expect(organization.defaultEnvironmentRestricted).toBe(false);

    const setRestricted = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { restricted: true },
    });
    expect(setRestricted.statusCode).toBe(200);
    expect(setRestricted.json().defaultEnvironmentRestricted).toBe(true);

    // PATCH only name; restricted must be preserved.
    const updateName = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Renamed" },
    });
    expect(updateName.statusCode).toBe(200);
    expect(updateName.json().defaultEnvironmentRestricted).toBe(true);

    // Turn it back off.
    const clearRestricted = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { restricted: false },
    });
    expect(clearRestricted.statusCode).toBe(200);
    expect(clearRestricted.json().defaultEnvironmentRestricted).toBe(false);
  });

  test("can set and clear the default environment network policy", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);
    const policy = await createNetworkPolicy({
      organizationId,
      data: { name: "Default egress" },
    });

    const setPolicy = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { networkPolicyId: policy.id },
    });
    expect(setPolicy.statusCode).toBe(200);
    expect(setPolicy.json().defaultNetworkPolicyId).toBe(policy.id);

    const clearPolicy = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { networkPolicyId: null },
    });
    expect(clearPolicy.statusCode).toBe(200);
    expect(clearPolicy.json().defaultNetworkPolicyId).toBeNull();
  });

  test("rejects default environment network policy from another organization", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const user = await makeUser();
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);
    const otherPolicy = await createNetworkPolicy({
      organizationId: otherOrganization.id,
      data: { name: "Other org default egress" },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { networkPolicyId: otherPolicy.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Network policy not found");
  });

  test("member without environment:update is forbidden", async ({
    makeUser,
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });
    const user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    app = await buildApp(user, organizationId);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/organization/default-environment",
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});
