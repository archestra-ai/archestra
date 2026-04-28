import { vi } from "vitest";
import { seedDefaultCluster } from "@/database/seed-default-cluster";
import ClusterModel from "@/models/cluster";
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

const { listNamespaceMock, makeApiClientMock } = vi.hoisted(() => ({
  listNamespaceMock: vi.fn(),
  makeApiClientMock: vi.fn(),
}));

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters: { name: string; server: string }[] = [];
    contexts: { name: string }[] = [];
    users: { name: string }[] = [];
    loadFromString(content: string) {
      // Minimal parse: just check whether the YAML-shaped string declares the
      // three required sections, so `validateKubeconfigContent` accepts it.
      // Tests that need to exercise the failure path pass garbage on purpose.
      if (/^\s*clusters:/m.test(content)) {
        this.clusters = [{ name: "mock", server: "https://mock.invalid" }];
      }
      if (/^\s*contexts:/m.test(content)) {
        this.contexts = [{ name: "mock" }];
      }
      if (/^\s*users:/m.test(content)) {
        this.users = [{ name: "mock" }];
      }
    }
    loadFromCluster() {}
    loadFromFile() {}
    loadFromDefault() {}
    makeApiClient(...args: unknown[]) {
      return makeApiClientMock(...args);
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
    Exec: vi.fn(),
  };
});

const { invalidateMock, invalidateAllMock, resolveForServerMock } = vi.hoisted(
  () => ({
    invalidateMock: vi.fn(),
    invalidateAllMock: vi.fn(),
    resolveForServerMock: vi.fn(),
  }),
);

vi.mock("@/k8s/mcp-server-runtime/cluster-registry", () => ({
  clusterRegistry: {
    invalidate: invalidateMock,
    invalidateAll: invalidateAllMock,
    resolveForServer: resolveForServerMock,
  },
  ClusterRegistry: class {},
}));

describe("cluster routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;
  let defaultClusterId: string;

  beforeEach(async ({ makeAdmin, makeOrganization, makeMember }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });
    makeApiClientMock.mockReturnValue({ listNamespace: listNamespaceMock });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    const seeded = await seedDefaultCluster();
    defaultClusterId = seeded.id;

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

    const { default: clusterRoutes } = await import("./cluster");
    await app.register(clusterRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("anonymous request to GET /api/clusters returns 401", async () => {
    const anonApp = createFastifyInstance();
    const { default: clusterRoutes } = await import("./cluster");
    await anonApp.register(clusterRoutes);

    const response = await anonApp.inject({
      method: "GET",
      url: "/api/clusters",
    });

    expect(response.statusCode).toBe(401);
    await anonApp.close();
  });

  test("non-admin authenticated user receives 403 from GET /api/clusters", async () => {
    hasPermissionMock.mockResolvedValue({ success: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/clusters",
    });

    expect(response.statusCode).toBe(403);
  });

  test("admin GET /api/clusters lists at least the seeded default cluster", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/clusters",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    const ids = body.map((row: { id: string }) => row.id);
    expect(ids).toContain(defaultClusterId);
    const defaultRow = body.find(
      (row: { id: string }) => row.id === defaultClusterId,
    );
    expect(defaultRow.isDefault).toBe(true);
    expect(defaultRow.name).toBe("default");
  });

  test("admin GET /api/clusters/:id returns 200 for known id and 404 for unknown id", async () => {
    const okResponse = await app.inject({
      method: "GET",
      url: `/api/clusters/${defaultClusterId}`,
    });
    expect(okResponse.statusCode).toBe(200);
    expect(okResponse.json().id).toBe(defaultClusterId);

    const missingResponse = await app.inject({
      method: "GET",
      url: "/api/clusters/00000000-0000-0000-0000-000000000000",
    });
    expect(missingResponse.statusCode).toBe(404);
  });

  test("admin POST /api/clusters creates a cluster and rejects isDefault override", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/clusters",
      payload: {
        name: "staging",
        namespace: "ns-staging",
        kubeconfigYaml:
          "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\ncontexts:\n  - name: c\nusers:\n  - name: c\n",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe("staging");
    expect(created.namespace).toBe("ns-staging");
    expect(created.isDefault).toBe(false);
    expect(created.kubeconfigSecretId).not.toBeNull();

    const rejectResponse = await app.inject({
      method: "POST",
      url: "/api/clusters",
      payload: {
        name: "rogue",
        namespace: "ns-rogue",
        kubeconfigYaml:
          "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\ncontexts:\n  - name: c\nusers:\n  - name: c\n",
        isDefault: true,
      },
    });
    expect(rejectResponse.statusCode).toBe(400);
  });

  test("admin PATCH /api/clusters/:id updates name, clears kubeconfig on null, and rejects isDefault changes", async () => {
    const created = await ClusterModel.create({
      name: "to-edit",
      namespace: "ns-edit",
      kubeconfigYaml:
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\ncontexts:\n  - name: c\nusers:\n  - name: c\n",
    });
    expect(created.kubeconfigSecretId).not.toBeNull();

    const renameResponse = await app.inject({
      method: "PATCH",
      url: `/api/clusters/${created.id}`,
      payload: { name: "renamed" },
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json().name).toBe("renamed");

    const clearResponse = await app.inject({
      method: "PATCH",
      url: `/api/clusters/${created.id}`,
      payload: { kubeconfigYaml: null },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json().kubeconfigSecretId).toBeNull();

    const rowAfter = await ClusterModel.getById(created.id);
    expect(rowAfter?.kubeconfigSecretId).toBeNull();

    const rejectResponse = await app.inject({
      method: "PATCH",
      url: `/api/clusters/${created.id}`,
      payload: { isDefault: true },
    });
    expect(rejectResponse.statusCode).toBe(400);
  });

  test("admin DELETE /api/clusters/:id removes non-default cluster and refuses to delete the default cluster", async () => {
    const created = await ClusterModel.create({
      name: "to-delete",
      namespace: "ns-del",
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/clusters/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(await ClusterModel.getById(created.id)).toBeNull();

    const refuseResponse = await app.inject({
      method: "DELETE",
      url: `/api/clusters/${defaultClusterId}`,
    });
    expect(refuseResponse.statusCode).toBe(400);
    expect(await ClusterModel.getById(defaultClusterId)).not.toBeNull();
  });

  test("POST /api/clusters/:id/test returns ok=true with namespacesVisible on success", async () => {
    const created = await ClusterModel.create({
      name: "probe-success",
      namespace: "ns-probe",
      kubeconfigYaml:
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\ncontexts:\n  - name: c\nusers:\n  - name: c\n",
    });

    listNamespaceMock.mockResolvedValueOnce({
      items: [{}, {}, {}],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/clusters/${created.id}/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, namespacesVisible: 3 });
    expect(listNamespaceMock).toHaveBeenCalledTimes(1);
  });

  test("POST /api/clusters/:id/test returns ok=false with error message when listNamespace rejects", async () => {
    const created = await ClusterModel.create({
      name: "probe-failure",
      namespace: "ns-probe",
      kubeconfigYaml:
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\ncontexts:\n  - name: c\nusers:\n  - name: c\n",
    });

    listNamespaceMock.mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({
      method: "POST",
      url: `/api/clusters/${created.id}/test`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("connection refused");
  });

  test("POST /api/clusters/:id/test returns 404 for an unknown cluster id", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clusters/00000000-0000-0000-0000-000000000000/test",
    });

    expect(response.statusCode).toBe(404);
  });

  test("PATCH and DELETE invalidate the cluster registry cache for the affected id", async () => {
    const created = await ClusterModel.create({
      name: "cache-target",
      namespace: "ns-cache",
    });

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/clusters/${created.id}`,
      payload: { name: "cache-target-renamed" },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(invalidateMock).toHaveBeenCalledWith(created.id);

    invalidateMock.mockClear();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/clusters/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(invalidateMock).toHaveBeenCalledWith(created.id);
  });
});
