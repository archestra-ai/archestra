import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { vi } from "vitest";
import {
  McpServerModel,
  OrganizationModel,
  PlaywrightRuntimeModel,
} from "@/models";
import { beforeEach, describe, expect, mustExist, test } from "@/test";
import {
  initializeManagedPlaywrightRuntime,
  reconcileManagedPlaywrightSetting,
} from "./playwright-runtime";

const {
  getOrLoadDeployment,
  reloadToolsForServer,
  waitForDeploymentReady,
  removeMcpServer,
  startServer,
} = vi.hoisted(() => ({
  getOrLoadDeployment: vi.fn(),
  removeMcpServer: vi.fn(),
  startServer: vi.fn(),
  reloadToolsForServer: vi.fn(),
  waitForDeploymentReady: vi.fn(),
}));

vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: { getOrLoadDeployment, removeMcpServer, startServer },
}));

vi.mock("@/services/mcp-reinstall", () => ({ reloadToolsForServer }));

describe("initializeManagedPlaywrightRuntime", () => {
  beforeEach(() => {
    removeMcpServer.mockResolvedValue(undefined);
    startServer.mockResolvedValue(undefined);
    getOrLoadDeployment.mockResolvedValue({ waitForDeploymentReady });
    waitForDeploymentReady.mockResolvedValue(undefined);
    reloadToolsForServer.mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      deleted: 0,
    });
  });

  test("waits for the Default runtime, discovers tools, and records success", async ({
    makeInternalMcpCatalog,
  }) => {
    await makeInternalMcpCatalog({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      organizationId: null,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      localConfig: {
        command: "node",
        transportType: "streamable-http",
        httpPort: 8080,
      },
    });
    await PlaywrightRuntimeModel.reconcileAll();
    const server = mustExist(
      await PlaywrightRuntimeModel.findForEnvironment(null),
    );

    await initializeManagedPlaywrightRuntime();

    expect(getOrLoadDeployment).toHaveBeenCalledWith(server.id);
    expect(waitForDeploymentReady).toHaveBeenCalledWith(60, 2000);
    expect(reloadToolsForServer).toHaveBeenCalledWith(server);
    expect(await McpServerModel.findById(server.id)).toMatchObject({
      localInstallationStatus: "success",
      localInstallationError: null,
    });
  });

  for (const failureStage of ["readiness", "discovery"]) {
    test(`preserves legacy installs after ${failureStage} failure and retires them after a successful retry`, async ({
      makeInternalMcpCatalog,
    }) => {
      await makeInternalMcpCatalog({
        id: PLAYWRIGHT_MCP_CATALOG_ID,
        organizationId: null,
        name: "microsoft__playwright-mcp",
        serverType: "local",
        localConfig: {
          command: "node",
          transportType: "streamable-http",
          httpPort: 8080,
        },
      });
      await PlaywrightRuntimeModel.reconcileAll();
      const server = mustExist(
        await PlaywrightRuntimeModel.findForEnvironment(null),
      );
      const legacy = await McpServerModel.create({
        name: "legacy-browser",
        catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
        serverType: "local",
        scope: "org",
      });
      const failingBoundary =
        failureStage === "readiness"
          ? waitForDeploymentReady
          : reloadToolsForServer;
      failingBoundary.mockRejectedValueOnce(
        new Error(`${failureStage} failed`),
      );

      await expect(
        initializeManagedPlaywrightRuntime(),
      ).resolves.toBeUndefined();

      expect(await McpServerModel.findById(server.id)).toMatchObject({
        localInstallationStatus: "error",
        localInstallationError: `${failureStage} failed`,
      });
      expect(await McpServerModel.findById(legacy.id)).not.toBeNull();

      await initializeManagedPlaywrightRuntime();

      expect(await McpServerModel.findById(legacy.id)).toBeNull();
      expect(await McpServerModel.findById(server.id)).toMatchObject({
        localInstallationStatus: "success",
        localInstallationError: null,
      });
    });
  }
});

test("disable tears down Default and environment runtimes, retains failures for retry, and prevents startup revival", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const organization = await makeOrganization();
  await makeInternalMcpCatalog({
    id: PLAYWRIGHT_MCP_CATALOG_ID,
    organizationId: null,
    name: "microsoft__playwright-mcp",
    serverType: "local",
  });
  const { default: EnvironmentModel } = await import("@/models/environment");
  await EnvironmentModel.create({
    organizationId: organization.id,
    name: "Extra",
    namespace: "extra",
  });
  const servers = await PlaywrightRuntimeModel.reconcileAll();
  removeMcpServer.mockResolvedValue(undefined);
  removeMcpServer.mockRejectedValueOnce(new Error("Kubernetes unavailable"));
  await expect(
    reconcileManagedPlaywrightSetting({
      organizationId: organization.id,
      settings: { playwrightMcpEnabled: false },
    }),
  ).rejects.toThrow("cleanup is incomplete");
  expect(
    (await OrganizationModel.getById(organization.id))?.playwrightMcpEnabled,
  ).toBe(false);
  expect(await PlaywrightRuntimeModel.findAllInstallations()).toHaveLength(1);
  expect(await PlaywrightRuntimeModel.reconcileAll()).toEqual([]);
  expect(removeMcpServer).toHaveBeenCalledWith(servers[0].id, {
    strictCleanup: true,
    requirePlaywrightDisabled: true,
  });
  await initializeManagedPlaywrightRuntime();
  expect(await PlaywrightRuntimeModel.findAllInstallations()).toEqual([]);
  for (const server of servers)
    expect(await McpServerModel.findById(server.id)).toBeNull();
  await reconcileManagedPlaywrightSetting({
    organizationId: organization.id,
    settings: { playwrightMcpEnabled: true },
  });
  expect(
    (await PlaywrightRuntimeModel.reconcileAll()).map((s) => s.id).sort(),
  ).toEqual(servers.map((s) => s.id).sort());
  expect(startServer).toHaveBeenCalled();
});

test("a late cleanup cannot retire a runtime after browser policy is re-enabled", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const organization = await makeOrganization();
  await makeInternalMcpCatalog({
    id: PLAYWRIGHT_MCP_CATALOG_ID,
    organizationId: null,
    name: "microsoft__playwright-mcp",
    serverType: "local",
  });
  const [server] = await PlaywrightRuntimeModel.reconcileAll();
  await OrganizationModel.patch(organization.id, {
    playwrightMcpEnabled: false,
  });
  removeMcpServer.mockImplementationOnce(async () => {
    await OrganizationModel.patch(organization.id, {
      playwrightMcpEnabled: true,
    });
  });
  expect(
    await McpServerModel.delete(server.id, {
      strictCleanup: true,
      requirePlaywrightDisabled: true,
    }),
  ).toBe(false);
  expect(await PlaywrightRuntimeModel.findForEnvironment(null)).toMatchObject({
    id: server.id,
  });
});

test("an enable waits for another replica's disable cleanup to finish", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const organization = await makeOrganization();
  await makeInternalMcpCatalog({
    id: PLAYWRIGHT_MCP_CATALOG_ID,
    organizationId: null,
    name: "microsoft__playwright-mcp",
    serverType: "local",
  });
  const [server] = await PlaywrightRuntimeModel.reconcileAll();
  removeMcpServer.mockClear();
  let releaseCleanup = () => {};
  const pendingCleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let signalCleanupStarted = () => {};
  const cleanupStarted = new Promise<void>((resolve) => {
    signalCleanupStarted = resolve;
  });
  removeMcpServer.mockImplementationOnce(() => {
    signalCleanupStarted();
    return pendingCleanup;
  });
  getOrLoadDeployment.mockResolvedValue({ waitForDeploymentReady });
  waitForDeploymentReady.mockResolvedValue(undefined);
  reloadToolsForServer.mockResolvedValue({
    created: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
  });
  const disabling = reconcileManagedPlaywrightSetting({
    organizationId: organization.id,
    settings: { playwrightMcpEnabled: false },
  });
  let enabling:
    | ReturnType<typeof reconcileManagedPlaywrightSetting>
    | undefined;
  try {
    // Synchronize on cleanup itself, rather than a scheduling deadline.
    await Promise.race([cleanupStarted, disabling]);
    expect(removeMcpServer).toHaveBeenCalledWith(server.id, {
      strictCleanup: true,
      requirePlaywrightDisabled: true,
    });
    enabling = reconcileManagedPlaywrightSetting({
      organizationId: organization.id,
      settings: { playwrightMcpEnabled: true },
    });
    expect(await PlaywrightRuntimeModel.isEnabled()).toBe(false);
  } finally {
    releaseCleanup();
    await Promise.all([disabling, enabling]);
  }
  expect(await PlaywrightRuntimeModel.findForEnvironment(null)).toMatchObject({
    id: server.id,
  });
  expect(await PlaywrightRuntimeModel.isEnabled()).toBe(true);
});
