import { usesMutableImageTag } from "@archestra/shared/mcp-image-pull-policy";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import {
  ClusterLeaseHeldError,
  InternalMcpCatalogModel,
  McpDeploymentLeaseModel,
  McpServerModel,
} from "@/models";
import { containerRegistryClient } from "@/services/container-registry";
import { refreshCatalogImage } from "@/services/mcp-image-refresh";
import type { InternalMcpCatalog, McpServer } from "@/types";

// Above the class: its field initializer reads them when the singleton below
// is constructed, before the bottom-of-file constants exist.
const ROLLED_OUT_DIGESTS_MAX_ENTRIES = 10_000;
const ROLLED_OUT_DIGEST_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rolls local MCP servers onto a new image when their mutable tag (`:latest`
 * or untagged) starts pointing at one.
 *
 * Stateless: every sweep compares the digest each running deployment's pods
 * report (`containerStatuses[].imageID`) with the digest the registry
 * currently serves for the tag, and runs the refresh-image action for the
 * installs that differ. Nothing is stored; a restarted backend picks up
 * exactly where the cluster is.
 *
 * Skipped without a registry request: pinned tags and digests, deployments
 * that are hibernated, scaled to zero, mid-rollout or not ready, pods whose
 * pull policy is not `Always` (a catalog that pinned `IfNotPresent` asked not
 * to depend on the registry), and pods that report no digest.
 *
 * Each distinct image (with its credentials) is looked up once per sweep. A
 * registry failure — unreachable, auth refused, rate-limited — skips that
 * catalog until the next sweep and never stops the rest.
 *
 * A digest is rolled out at most once per install (per replica, for a day):
 * if a registry reports digests that never match what the pod records, the
 * checker logs it instead of restarting the server every sweep.
 *
 * Multiple replicas: each catalog's check-and-refresh runs under a cluster
 * lease, so only one replica acts on it; the others skip it. Sweeps start
 * after a random delay so replicas do not hit registries in lockstep.
 */
class McpImageUpdateChecker {
  private intervalId: NodeJS.Timeout | null = null;
  private pendingSweep: NodeJS.Timeout | null = null;
  private sweepInProgress = false;
  // serverId -> registry digest this replica last rolled the install out to.
  private readonly rolledOutDigests = new LRUCacheManager<string>({
    maxSize: ROLLED_OUT_DIGESTS_MAX_ENTRIES,
    defaultTtl: ROLLED_OUT_DIGEST_TTL_MS,
  });

  start(): void {
    const intervalMinutes =
      config.orchestrator.mcpImageUpdateCheckIntervalMinutes;
    if (intervalMinutes <= 0 || this.intervalId) return;
    const intervalMs = intervalMinutes * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.scheduleSweep(intervalMs);
    }, intervalMs);
    this.intervalId.unref();
    logger.info({ intervalMinutes }, "MCP image update check enabled");
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.pendingSweep) {
      clearTimeout(this.pendingSweep);
      this.pendingSweep = null;
    }
  }

  /**
   * One full sweep — what each interval tick runs after its jitter. Public so
   * a sweep can be run directly (tests) without waiting for the timer.
   */
  async checkAll(): Promise<void> {
    if (this.sweepInProgress) return;
    this.sweepInProgress = true;
    try {
      if (!McpServerRuntimeManager.isEnabled) return;
      const installsByCatalog = groupByCatalog(await McpServerModel.findAll());
      if (installsByCatalog.size === 0) return;
      const catalogs = await InternalMcpCatalogModel.getByIds([
        ...installsByCatalog.keys(),
      ]);
      const digestLookups = new Map<string, Promise<string>>();

      for (const [catalogId, installs] of installsByCatalog) {
        const catalog = catalogs.get(catalogId);
        if (!catalog || !mayUseMutableImage(catalog)) continue;
        try {
          await this.checkCatalog({ catalog, installs, digestLookups });
        } catch (error) {
          if (error instanceof ClusterLeaseHeldError) {
            logger.debug(
              { catalogId },
              "Another replica is checking this MCP catalog's image",
            );
            continue;
          }
          logger.warn(
            { err: error, catalogId, catalogName: catalog.name },
            "MCP image update check failed for catalog; retrying next interval",
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, "MCP image update check sweep failed");
    } finally {
      this.sweepInProgress = false;
    }
  }

  // ===
  // Private helpers
  // ===

  private scheduleSweep(intervalMs: number): void {
    if (this.pendingSweep) return;
    const jitterMs = Math.random() * Math.min(intervalMs / 4, MAX_JITTER_MS);
    this.pendingSweep = setTimeout(() => {
      this.pendingSweep = null;
      void this.checkAll();
    }, jitterMs);
    this.pendingSweep.unref();
  }

  private async checkCatalog(params: {
    catalog: InternalMcpCatalog;
    installs: McpServer[];
    digestLookups: Map<string, Promise<string>>;
  }): Promise<void> {
    const { catalog, installs, digestLookups } = params;
    await McpDeploymentLeaseModel.withLease(
      { scope: IMAGE_UPDATE_LEASE_SCOPE, key: catalog.id },
      async (lease) => {
        // A multi-tenant catalog runs one shared deployment for every install.
        const candidates = catalog.multitenant
          ? installs.slice(0, 1)
          : installs;
        const outdated: Array<{ server: McpServer; registryDigest: string }> =
          [];
        for (const server of candidates) {
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          // A hibernated deployment pulls the tag afresh when demand wakes it;
          // refreshing it now would wake it for nothing.
          if (McpServerRuntimeManager.isDeploymentDormant(server.id)) continue;
          // SPDX-SnippetEnd
          const running = await McpServerRuntimeManager.readRunningImage(
            server.id,
          );
          if (
            !running ||
            running.pullPolicy !== "Always" ||
            !usesMutableImageTag(running.image)
          ) {
            continue;
          }
          const dockerConfigs =
            await McpServerRuntimeManager.readImagePullSecretConfigs({
              mcpServerId: server.id,
              secretNames: running.pullSecretNames,
            });
          const registryDigest = await lookupDigest({
            image: running.image,
            dockerConfigs,
            digestLookups,
          });
          if (registryDigest === running.digest) continue;
          if (this.rolledOutDigests.get(server.id) === registryDigest) {
            logger.warn(
              {
                catalogId: catalog.id,
                serverId: server.id,
                image: running.image,
                runningDigest: running.digest,
                registryDigest,
              },
              "MCP server still reports a different image digest after a rollout to it; not restarting again",
            );
            continue;
          }
          logger.info(
            {
              catalogId: catalog.id,
              serverId: server.id,
              image: running.image,
              runningDigest: running.digest,
              registryDigest,
            },
            "MCP server image tag points at a new image; rolling it out",
          );
          outdated.push({ server, registryDigest });
        }
        if (outdated.length === 0) return;

        lease.throwIfLost();
        for (const { server, registryDigest } of outdated) {
          this.rolledOutDigests.set(server.id, registryDigest);
        }
        await refreshCatalogImage(
          catalog,
          catalog.multitenant
            ? undefined
            : { serverIds: outdated.map(({ server }) => server.id) },
        );
      },
    );
  }
}

export const mcpImageUpdateChecker = new McpImageUpdateChecker();

// ===
// Internal helpers
// ===

const IMAGE_UPDATE_LEASE_SCOPE = "mcp-image-update";
const MAX_JITTER_MS = 60_000;

function groupByCatalog(servers: McpServer[]): Map<string, McpServer[]> {
  const grouped = new Map<string, McpServer[]>();
  for (const server of servers) {
    if (!server.catalogId) continue;
    const existing = grouped.get(server.catalogId);
    if (existing) existing.push(server);
    else grouped.set(server.catalogId, [server]);
  }
  return grouped;
}

/**
 * Cheap pre-filter before any Kubernetes read: a local catalog whose
 * configured image is pinned can only run a pinned image. A custom
 * deployment YAML may name its own image, so those are judged by the pod.
 */
function mayUseMutableImage(catalog: InternalMcpCatalog): boolean {
  if (catalog.serverType !== "local") return false;
  if (catalog.deploymentSpecYaml) return true;
  const image =
    catalog.localConfig?.dockerImage?.trim() ||
    config.orchestrator.mcpServerBaseImage;
  return usesMutableImageTag(image);
}

function lookupDigest(params: {
  image: string;
  dockerConfigs: string[];
  digestLookups: Map<string, Promise<string>>;
}): Promise<string> {
  const key = JSON.stringify([params.image, params.dockerConfigs]);
  let pending = params.digestLookups.get(key);
  if (!pending) {
    pending = containerRegistryClient.getTagDigest({
      image: params.image,
      dockerConfigs: params.dockerConfigs,
    });
    params.digestLookups.set(key, pending);
  }
  return pending;
}
