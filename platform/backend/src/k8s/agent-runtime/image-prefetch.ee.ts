// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash } from "node:crypto";
import { getAgentCatalogImages } from "@archestra/shared";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { buildPrepullDaemonSet } from "@/k8s/mcp-server-runtime/image-prepuller.ee";
import { resolveRuntimeOwnerReferences } from "@/k8s/mcp-server-runtime/runtime-owner";
import {
  createK8sClients,
  isK8sConflictError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";

/** Warm the popular catalog at boot, without blocking server readiness.
 * DaemonSets also cover nodes added after startup. Kubelet skips cached images. */
class AgentImagePrefetcher {
  private timer: NodeJS.Timeout | undefined;
  private clients: ReturnType<typeof createK8sClients> | undefined;
  private inFlight = false;

  start(): void {
    if (this.timer || !config.agentRuntime.enabled) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile(): Promise<void> {
    if (
      this.inFlight ||
      !config.agentRuntime.enabled ||
      !enterpriseTier.isCoreActive()
    )
      return;
    this.inFlight = true;
    try {
      this.clients ??= this.createClients();
      const { appsApi, coreApi, rbacApi, namespace } = this.clients;
      const release =
        config.orchestrator.kubernetes.helmReleaseName || "archestra";
      const labels = {
        "app.kubernetes.io/managed-by": "archestra",
        "app.kubernetes.io/component": "agent-image-prefetch",
        "app.kubernetes.io/instance": release,
      };
      const labelSelector = Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
      const [existing, account, ownerReferences] = await Promise.all([
        appsApi.listNamespacedDaemonSet({ namespace, labelSelector }),
        coreApi.readNamespacedServiceAccount({ namespace, name: "default" }),
        resolveRuntimeOwnerReferences(rbacApi, namespace),
      ]);
      const settings = config.orchestrator.mcpImagePrepull;
      const pullSecretNames = [
        ...new Set([
          ...(account.imagePullSecrets ?? []).flatMap(({ name }) =>
            name ? [name] : [],
          ),
          ...settings.bootstrapImagePullSecrets,
        ]),
      ].sort();
      const names = new Set<string>();
      // One DaemonSet per image: an unavailable image must not block its peers.
      for (const image of new Set(
        Object.values(getAgentCatalogImages(config.agentRuntime.defaultImage)),
      )) {
        const name = `${release.slice(0, 30).replace(/-$/, "")}-agent-image-${hash(`${release}:${image}`).slice(0, 12)}`;
        names.add(name);
        const desired = buildPrepullDaemonSet({
          name,
          namespace,
          images: [image],
          pullSecretNames,
          bootstrapImage: settings.bootstrapImage,
          nodeSelector: config.agentRuntime.nodeSelector,
          tolerations: Object.entries(config.agentRuntime.nodeSelector).map(
            ([key, value]) => ({
              key,
              value,
              operator: "Equal",
              effect: "NoSchedule",
            }),
          ),
          ownerReferences,
          resources: settings.resources,
          priorityClassName: settings.priorityClassName,
        });
        if (!desired.metadata || !desired.spec?.template.spec) continue;
        desired.metadata.labels = { app: name, ...labels };
        desired.spec.template.metadata = { labels: { app: name, ...labels } };
        const fingerprint = hash(
          JSON.stringify({ spec: desired.spec, ownerReferences }),
        );
        desired.metadata.annotations = { [FINGERPRINT]: fingerprint };
        const previous = existing.items.find(
          (item) => item.metadata?.name === name,
        );
        if (previous?.metadata?.annotations?.[FINGERPRINT] === fingerprint)
          continue;
        try {
          if (previous) {
            desired.metadata.resourceVersion =
              previous.metadata?.resourceVersion;
            await appsApi.replaceNamespacedDaemonSet({
              namespace,
              name,
              body: desired,
            });
          } else {
            await appsApi.createNamespacedDaemonSet({
              namespace,
              body: desired,
            });
          }
        } catch (error) {
          if (!isK8sConflictError(error)) throw error;
          // Another replica reconciled this image. Recheck on the next pass.
        }
      }
      for (const previous of existing.items) {
        if (!previous.metadata?.name || names.has(previous.metadata.name))
          continue;
        await appsApi.deleteNamespacedDaemonSet({
          namespace,
          name: previous.metadata.name,
          body: {
            preconditions: {
              uid: previous.metadata.uid,
              resourceVersion: previous.metadata.resourceVersion,
            },
          },
        });
      }
    } catch (error) {
      logger.warn(
        { error },
        "Popular Agent image prefetch failed; startup will pull missing images normally",
      );
    } finally {
      this.inFlight = false;
    }
  }

  private createClients() {
    const { kubeConfig, namespace } = loadKubeConfig();
    return createK8sClients(kubeConfig, namespace);
  }
}

export const agentImagePrefetcher = new AgentImagePrefetcher();

const FINGERPRINT = "archestra.io/agent-image-prefetch-hash";
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
