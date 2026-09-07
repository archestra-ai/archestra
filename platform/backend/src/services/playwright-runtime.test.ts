import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { vi } from "vitest";
import { McpServerModel, PlaywrightRuntimeModel } from "@/models";
import { beforeEach, describe, expect, mustExist, test } from "@/test";
import { initializeManagedPlaywrightRuntime } from "./playwright-runtime";

const { getOrLoadDeployment, reloadToolsForServer, waitForDeploymentReady } =
  vi.hoisted(() => ({
    getOrLoadDeployment: vi.fn(),
    reloadToolsForServer: vi.fn(),
    waitForDeploymentReady: vi.fn(),
  }));

vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: { getOrLoadDeployment },
}));

vi.mock("@/services/mcp-reinstall", () => ({ reloadToolsForServer }));

describe("initializeManagedPlaywrightRuntime", () => {
  beforeEach(() => {
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

  test("records a discovery failure without removing the managed runtime", async ({
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
    reloadToolsForServer.mockRejectedValueOnce(new Error("discovery failed"));

    await expect(initializeManagedPlaywrightRuntime()).resolves.toBeUndefined();

    expect(await McpServerModel.findById(server.id)).toMatchObject({
      localInstallationStatus: "error",
      localInstallationError: "discovery failed",
    });
  });
});
