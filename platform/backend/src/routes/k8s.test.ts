import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

// Prevent actual k8s API calls
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    listNamespaces: vi.fn().mockResolvedValue(["default", "kube-system"]),
    getDefaultNamespace: vi.fn().mockReturnValue("default"),
    isEnabled: true,
  },
}));

import { hasPermission } from "@/auth";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { K8sClusterModel } from "@/models";

const mockHasPermission = hasPermission as Mock;
const mockListNamespaces = McpServerRuntimeManager.listNamespaces as Mock;

const VALID_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://test-cluster.example.com
  name: test-cluster
contexts:
- context:
    cluster: test-cluster
    user: test-user
  name: test-context
current-context: test-context
users:
- name: test-user
  user:
    token: test-token
`;

function grantAdminPermissions() {
  mockHasPermission.mockResolvedValue({ success: true, error: null });
}

function denyPermissions() {
  mockHasPermission.mockResolvedValue({
    success: false,
    error: "Forbidden",
  });
}

describe("K8s routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    grantAdminPermissions();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./k8s");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ====== GET /api/k8s/clusters ======

  describe("GET /api/k8s/clusters", () => {
    test("returns default cluster entry plus custom clusters", async () => {
      await K8sClusterModel.create({
        organizationId,
        name: "My Cluster",
        kubeconfig: VALID_KUBECONFIG,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/k8s/clusters",
      });

      expect(response.statusCode).toBe(200);
      const { clusters } = response.json();
      expect(clusters).toHaveLength(2);
      expect(clusters[0]).toMatchObject({
        id: null,
        name: "Default (platform cluster)",
      });
      expect(clusters[1]).toMatchObject({ name: "My Cluster" });
    });

    test("returns only default entry when no custom clusters exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/k8s/clusters",
      });

      expect(response.statusCode).toBe(200);
      const { clusters } = response.json();
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toMatchObject({ id: null });
    });

    test("returns 403 when user lacks read permission", async () => {
      denyPermissions();

      const response = await app.inject({
        method: "GET",
        url: "/api/k8s/clusters",
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ====== POST /api/k8s/clusters ======

  describe("POST /api/k8s/clusters", () => {
    test("creates a cluster with valid kubeconfig", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/k8s/clusters",
        payload: { name: "Prod Cluster", kubeconfig: VALID_KUBECONFIG },
      });

      expect(response.statusCode).toBe(200);
      const cluster = response.json();
      expect(cluster.name).toBe("Prod Cluster");
      expect(cluster.organizationId).toBe(organizationId);
    });

    test("returns 400 for invalid kubeconfig", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/k8s/clusters",
        payload: {
          name: "Bad",
          kubeconfig: "this is not valid yaml kubeconfig",
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 403 when user lacks admin permission", async () => {
      denyPermissions();

      const response = await app.inject({
        method: "POST",
        url: "/api/k8s/clusters",
        payload: { name: "X", kubeconfig: VALID_KUBECONFIG },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ====== DELETE /api/k8s/clusters/:id ======

  describe("DELETE /api/k8s/clusters/:id", () => {
    test("deletes an existing cluster", async () => {
      const cluster = await K8sClusterModel.create({
        organizationId,
        name: "To Delete",
        kubeconfig: VALID_KUBECONFIG,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/k8s/clusters/${cluster.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true });

      const found = await K8sClusterModel.findById(cluster.id, organizationId);
      expect(found).toBeNull();
    });

    test("returns 404 for non-existent cluster", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/k8s/clusters/00000000-0000-4000-a000-000000000000",
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 403 when user lacks admin permission", async () => {
      denyPermissions();

      const response = await app.inject({
        method: "DELETE",
        url: "/api/k8s/clusters/00000000-0000-4000-a000-000000000000",
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ====== GET /api/k8s/namespaces ======

  describe("GET /api/k8s/namespaces", () => {
    test("lists namespaces using default cluster when no clusterId given", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/k8s/namespaces",
      });

      expect(response.statusCode).toBe(200);
      const { namespaces, defaultNamespace } = response.json();
      expect(namespaces).toEqual(["default", "kube-system"]);
      expect(defaultNamespace).toBe("default");
      expect(mockListNamespaces).toHaveBeenCalledWith(null);
    });

    test("lists namespaces using custom cluster when clusterId is given", async () => {
      const cluster = await K8sClusterModel.create({
        organizationId,
        name: "My Cluster",
        kubeconfig: VALID_KUBECONFIG,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/k8s/namespaces?clusterId=${cluster.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(mockListNamespaces).toHaveBeenCalledWith(
        expect.objectContaining({ id: cluster.id }),
      );
    });

    test("returns 404 when clusterId does not belong to org", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/k8s/namespaces?clusterId=00000000-0000-4000-a000-000000000000",
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
