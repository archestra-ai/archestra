import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

// Force the K8s runtime ON so the route's relocation branch is exercised, and
// stub the cluster calls. The teardown/recreate primitives are no-ops here; we
// only assert which the route picks and what it's called with.
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: true,
    getOrLoadDeployment: vi.fn().mockResolvedValue(undefined),
    tearDownOldNamespaceDeployments: vi.fn().mockResolvedValue(undefined),
    reinstallSharedDeployment: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    validateNamespace: vi.fn().mockResolvedValue(undefined),
  },
}));

import { hasPermission } from "@/auth";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { createEnvironment } from "@/services/environments/environment";

const mockHasPermission = hasPermission as Mock;
const reinstallSpy = mcpServerRuntimeManager.reinstallSharedDeployment as Mock;
const tearDownSpy =
  mcpServerRuntimeManager.tearDownOldNamespaceDeployments as Mock;

// The cascade runs in `setImmediate` after the response; drain real ticks so it
// settles before the app closes (its per-install tool sync errors harmlessly
// against the stubbed runtime).
async function drainCascade(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Reassigning a *multi-tenant* local catalog item to a different environment
 * must relocate its shared K8s Deployment to the new namespace. A per-install
 * restart no-ops on a shared deployment (the sibling guard), so the route
 * relocates it explicitly via `reinstallSharedDeployment` — the same primitive
 * the environment-namespace-edit route uses. Single-tenant catalogs keep using
 * the cascade's per-install restart and must NOT hit that primitive.
 */
describe("PUT /api/internal_mcp_catalog/:id — environment relocation", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    await drainCascade();
    vi.restoreAllMocks();
    await app.close();
  });

  const localConfig = {
    command: "node",
    arguments: ["server.js"],
    environment: [],
  };

  function putBody(name: string, environmentId: string | null) {
    return {
      name,
      serverType: "local" as const,
      localConfig,
      environmentId,
    };
  }

  test("multi-tenant local catalog: env reassignment relocates the shared deployment", async ({
    makeMcpServer,
  }) => {
    const from = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const to = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `mt-relocate-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: true,
        environmentId: from.id,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: putBody(name, to.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(to.id);
    // Shared deployment recreated in the new namespace via the catalog-level
    // primitive...
    expect(reinstallSpy).toHaveBeenCalledWith(catalog.id);
    // ...and the OLD-namespace deployment was torn down first, using the
    // pre-update snapshot (still carrying the old environment) so the teardown
    // resolves the old namespace — and BEFORE the recreate.
    expect(tearDownSpy).toHaveBeenCalled();
    expect(tearDownSpy.mock.calls[0][0]?.environmentId).toBe(from.id);
    expect(tearDownSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reinstallSpy.mock.invocationCallOrder[0],
    );
  });

  test("single-tenant local catalog: env reassignment relocates via per-install restart, not the shared primitive", async ({
    makeMcpServer,
  }) => {
    const from = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const to = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `st-relocate-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: false,
        environmentId: from.id,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: putBody(name, to.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(to.id);
    // The OLD-namespace deployment is torn down explicitly, using the pre-update
    // snapshot (still carrying the old environment) so the teardown resolves the
    // OLD namespace — not the now-updated row, which a cache-stale replica would
    // otherwise re-resolve to the new namespace, orphaning the old pod.
    expect(tearDownSpy).toHaveBeenCalled();
    expect(tearDownSpy.mock.calls[0][0]?.environmentId).toBe(from.id);

    await drainCascade();
    // Single-tenant recreates via the cascade's per-install restart, never the
    // shared-deployment primitive (that path no-ops on a shared deployment).
    expect(reinstallSpy).not.toHaveBeenCalled();
  });

  test("single-tenant: reassignment back to default (null) tears down the old env namespace", async ({
    makeMcpServer,
  }) => {
    const from = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `st-to-default-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: false,
        environmentId: from.id,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: putBody(name, null),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
    // Prod→Default is the direction observed orphaning a pod in the previous
    // environment's namespace. The teardown must use the pre-update snapshot
    // (environmentId = the Prod env) so it removes the pod from THAT namespace —
    // not the default it's moving to. Passing the new (null) env here is exactly
    // the bug: it would resolve to the default namespace and orphan the old pod.
    expect(tearDownSpy).toHaveBeenCalled();
    expect(tearDownSpy.mock.calls[0][0]?.environmentId).toBe(from.id);

    await drainCascade();
    expect(reinstallSpy).not.toHaveBeenCalled();
  });

  test("single-tenant: combined environment + command change does NOT tear down (cascade defers recreate to manual reinstall)", async ({
    makeMcpServer,
  }) => {
    const from = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const to = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `st-combined-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: false,
        environmentId: from.id,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local" as const,
        // Environment changes AND the command changes in the same edit →
        // requiresNewUserInputForReinstall is true for single-tenant, so the
        // cascade marks the install reinstall-required and does NOT recreate.
        localConfig: { ...localConfig, command: "bun" },
        environmentId: to.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(to.id);
    await drainCascade();
    // Because the pod is NOT recreated (manual reinstall pending), the
    // old-namespace deployment must NOT be torn down — doing so would leave the
    // install with no running pod until the user reinstalls.
    expect(tearDownSpy).not.toHaveBeenCalled();
    expect(reinstallSpy).not.toHaveBeenCalled();
  });

  test("multi-tenant: assigning from default (null) to an environment relocates the shared deployment", async ({
    makeMcpServer,
  }) => {
    const to = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `mt-from-default-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: true,
        environmentId: null,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: putBody(name, to.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(to.id);
    expect(reinstallSpy).toHaveBeenCalledWith(catalog.id);
  });

  test("multi-tenant: a combined environment + command change still relocates the shared deployment", async ({
    makeMcpServer,
  }) => {
    const from = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const to = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: false },
    });

    const name = `mt-combined-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: true,
        environmentId: from.id,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local" as const,
        // Environment changes AND the command changes in the same edit.
        localConfig: { ...localConfig, command: "bun" },
        environmentId: to.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reinstallSpy).toHaveBeenCalledWith(catalog.id);
  });
});
