import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  OrganizationModel,
  PlaywrightRuntimeModel,
} from "@/models";
import { expect, mustExist, test } from "@/test";
import K8sDeployment from "./k8s-deployment";

test("disabled browser runtimes cannot be provisioned or woken in Default or explicit environments", async ({
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
  await EnvironmentModel.create({
    organizationId: organization.id,
    name: "Browser fixture",
    namespace: "browser-fixture",
  });
  const servers = await PlaywrightRuntimeModel.reconcileAll();
  await OrganizationModel.patch(organization.id, {
    playwrightMcpEnabled: false,
  });
  const patchNamespacedDeployment = vi.fn();
  const createNamespacedDeployment = vi.fn();
  for (const server of servers) {
    const catalogItem = mustExist(
      await InternalMcpCatalogModel.findById(server.catalogId),
    );
    const deployment = new K8sDeployment({
      mcpServer: server,
      catalogItem,
      namespace: "browser-fixture",
      k8sApi: {} as k8s.CoreV1Api,
      k8sAppsApi: {
        patchNamespacedDeployment,
        createNamespacedDeployment,
      } as unknown as k8s.AppsV1Api,
      k8sAttach: {} as k8s.Attach,
      k8sLog: {} as k8s.Log,
      k8sExec: {} as k8s.Exec,
    });
    await expect(deployment.beginWake()).rejects.toThrow(
      "built-in browser MCP is disabled",
    );
    await expect(deployment.startOrCreateDeployment()).rejects.toThrow(
      "built-in browser MCP is disabled",
    );
  }
  expect(patchNamespacedDeployment).not.toHaveBeenCalled();
  expect(createNamespacedDeployment).not.toHaveBeenCalled();
});
