import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { OrganizationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import K8sDeployment from "./k8s-deployment";
import { McpServerRuntimeManager } from "./manager";

type ManagerInternals = {
  status: string;
  mcpServerIdToDeploymentMap: Map<string, K8sDeployment>;
};

/**
 * The one Deployment an alias acts on, with the two merge-patch behaviours the
 * hibernation lifecycle is built on: annotations merge (a null value deletes
 * the key) and `spec` fields overwrite.
 */
class FakeDeployment {
  replicas = 1;
  annotations: Record<string, string> = {};

  read(): k8s.V1Deployment {
    return {
      metadata: {
        name: DEPLOYMENT_NAME,
        namespace: "default",
        annotations: { ...this.annotations },
        resourceVersion: "1",
      },
      spec: { replicas: this.replicas },
      status: {
        availableReplicas: this.replicas,
        readyReplicas: this.replicas,
      },
    } as k8s.V1Deployment;
  }

  patch(body: k8s.V1Deployment): void {
    for (const [key, value] of Object.entries(
      body.metadata?.annotations ?? {},
    )) {
      if (value === null) {
        delete this.annotations[key];
      } else {
        this.annotations[key] = value;
      }
    }
    if (body.spec?.replicas !== undefined) {
      this.replicas = body.spec.replicas;
    }
  }
}

const DEPLOYMENT_NAME = "mcp-some-server";

/**
 * The K8sDeployment the runtime registers for an install: exactly what
 * `getOrLoadDeployment` constructs, so the state it starts in and the states
 * its lifecycle methods reach are the real ones, not a hand-written summary.
 */
function loadAlias(mcpServer: McpServer, live: FakeDeployment): K8sDeployment {
  const k8sAppsApi = {
    readNamespacedDeployment: vi.fn(async () => live.read()),
    patchNamespacedDeployment: vi.fn(async ({ body }: { body: unknown }) => {
      live.patch(body as k8s.V1Deployment);
      return live.read();
    }),
  } as unknown as k8s.AppsV1Api;

  return new K8sDeployment({
    mcpServer,
    k8sApi: {} as k8s.CoreV1Api,
    k8sAppsApi,
    k8sAttach: {} as k8s.Attach,
    k8sLog: {} as k8s.Log,
    k8sExec: {} as k8s.Exec,
    namespace: "default",
  });
}

describe("McpServerRuntimeManager.isDeploymentDormant", () => {
  let manager: McpServerRuntimeManager;
  let internals: ManagerInternals;
  let betaEnabled: boolean;
  let hardDisabled: boolean;
  let live: FakeDeployment;

  beforeEach(() => {
    betaEnabled = config.orchestrator.mcpIdleHibernation.betaEnabled;
    hardDisabled = config.orchestrator.mcpIdleHibernation.hardDisabled;
    // Idle hibernation fully on: offered by the deployment, licensed, and
    // opted into by the organization. Dormancy is a no-op below any of these.
    config.orchestrator.mcpIdleHibernation.betaEnabled = true;
    config.orchestrator.mcpIdleHibernation.hardDisabled = false;
    vi.spyOn(enterpriseTier, "isCoreActive").mockReturnValue(true);
    vi.spyOn(
      OrganizationModel,
      "getMcpIdleHibernationEnabledSync",
    ).mockReturnValue(true);

    manager = new McpServerRuntimeManager();
    internals = manager as unknown as ManagerInternals;
    internals.status = "running";
    live = new FakeDeployment();
  });

  afterEach(() => {
    config.orchestrator.mcpIdleHibernation.betaEnabled = betaEnabled;
    config.orchestrator.mcpIdleHibernation.hardDisabled = hardDisabled;
    vi.restoreAllMocks();
  });

  test("a lazily loaded alias is a cold cache, and says nothing about the cluster", async ({
    makeMcpServer,
  }) => {
    const mcpServer = await makeMcpServer({ deploymentName: DEPLOYMENT_NAME });
    const alias = loadAlias(mcpServer as McpServer, live);

    // Where a freshly loaded alias sits, and stays: the state refresh
    // re-evaluates only deployments already believed to exist, so a healthy
    // server keeps this state — and, for the same reason, never acquires the
    // pod telemetry that might have distinguished it from a sleeping one.
    expect(alias.statusSummary.state).toBe("not_created");
    expect(alias.statusSummary.podName).toBeUndefined();

    internals.mcpServerIdToDeploymentMap.set(mcpServer.id, alias);

    // Reading that placeholder as sleep dropped healthy servers' resources and
    // prompts from every pooled listing, for the life of the process.
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(false);
    expect(manager.isDeploymentDormant("never-loaded")).toBe(false);
  });

  test("a deployment this process put to sleep is dormant until it serves again", async ({
    makeMcpServer,
  }) => {
    const mcpServer = await makeMcpServer({ deploymentName: DEPLOYMENT_NAME });
    const alias = loadAlias(mcpServer as McpServer, live);
    internals.mcpServerIdToDeploymentMap.set(mcpServer.id, alias);

    // The sweeper only ever hibernates a deployment it has seen serving, and
    // the manager mirrors that observation onto every alias of the physical
    // deployment — the one route by which a lazily loaded alias learns a state.
    alias.syncStateFromSibling("running");
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(false);

    await alias.hibernate();
    expect(live.replicas).toBe(0);
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(true);

    // Scaled back up but not yet ready: still nothing to connect to.
    await alias.beginWake();
    expect(live.replicas).toBe(1);
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(true);

    await alias.completeWake();
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(false);
  });

  test("nothing is dormant while idle hibernation is off", async ({
    makeMcpServer,
  }) => {
    const mcpServer = await makeMcpServer({ deploymentName: DEPLOYMENT_NAME });
    const alias = loadAlias(mcpServer as McpServer, live);
    internals.mcpServerIdToDeploymentMap.set(mcpServer.id, alias);
    alias.syncStateFromSibling("running");
    await alias.hibernate();

    config.orchestrator.mcpIdleHibernation.betaEnabled = false;

    // Without a sweeper nothing can be put to sleep, so a background path must
    // never lose a server to a state left over from before the feature was off.
    expect(manager.isDeploymentDormant(mcpServer.id)).toBe(false);
  });
});
