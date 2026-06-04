import type { RouteId } from "@shared";
import { requiredEndpointPermissionsMap } from "@shared/access-control";
import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/k8s/capabilities", () => ({
  getK8sCapabilities: vi.fn(),
}));

import { hasPermission } from "@/auth";
import { getK8sCapabilities } from "@/k8s/capabilities";

const mockHasPermission = hasPermission as Mock;
const mockGetK8sCapabilities = getK8sCapabilities as Mock;

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

  const { default: k8sCapabilitiesRoutes } = await import("./k8s-capabilities");
  await app.register(k8sCapabilitiesRoutes);
  return app;
}

describe("k8s capabilities routes", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("returns detected Kubernetes network policy capabilities", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    mockGetK8sCapabilities.mockResolvedValue({
      networkPolicy: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: true,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "cilium",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: "CiliumNetworkPolicy API detected.",
      },
    });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/k8s/capabilities",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      networkPolicy: {
        kubernetesNetworkPolicy: true,
        ciliumNetworkPolicy: true,
        gkeFqdnNetworkPolicy: false,
        awsApplicationNetworkPolicy: false,
        provider: "cilium",
        supportsFqdn: true,
        supportsHttpMethods: false,
        message: "CiliumNetworkPolicy API detected.",
      },
    });
  });

  test("requires environment admin permission", async ({
    makeOrganization,
    makeUser,
  }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });
    const user = await makeUser();
    const organization = await makeOrganization();
    app = await buildApp(user, organization.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/k8s/capabilities",
    });

    expect(response.statusCode).toBe(403);
    expect(mockHasPermission).toHaveBeenCalledWith(
      { environment: ["admin"] },
      expect.any(Object),
    );
  });
});
