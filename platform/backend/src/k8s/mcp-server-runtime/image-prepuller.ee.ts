// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import {
  isK8sConflictError,
  isK8sNotFoundError,
  withK8sApiRetry,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpServerModel,
  OrganizationModel,
} from "@/models";
import { isIdleHibernationOffered } from "./hibernation.ee";
import { getMcpImagePullPolicy } from "./image-pull-policy";
import K8sDeployment from "./k8s-deployment";
import { resolveRuntimeOwnerReferences } from "./runtime-owner";

/**
 * Keeps every node's image cache warm for idle hibernation.
 *
 * Hibernation scales an MCP Deployment to zero and its wake is only fast — and
 * only survives a registry outage — while the node it lands on already holds
 * the image, because generated deployments pull `IfNotPresent` (see
 * image-pull-policy.ts). Nothing maintains that on its own: a node the cluster
 * autoscaler just added starts empty, so a wake onto a fresh node needs the
 * registry after all. This reconciler turns the cache from an accident into a
 * maintained guarantee.
 *
 * The shape is a DaemonSet, because that is the only one that covers EVERY
 * node including the ones provisioned after we last looked. It carries one
 * init container per image to cache: the kubelet must PULL an init container's
 * image before it can run it, which is the entire point — the command itself
 * only has to exit 0. That command is a statically linked busybox the first
 * init container copies out of the Archestra MCP base image into a shared
 * emptyDir, because it is exec'd inside arbitrary target images that may use a
 * different libc or ship no shell at all (scratch/distroless).
 *
 * Pre-pulling is an OPTIMISATION and is written like one: every failure is
 * caught and logged, nothing here is ever awaited by a hibernate, a wake, an
 * install, or a tool call, and a reconcile that cannot run simply does not
 * happen.
 *
 * Init containers run in sequence, which makes one un-pullable image expensive
 * out of all proportion: every image ordered after it stops caching too, on
 * every node. Two things keep that from happening.
 *
 *  - An image is only listed when the pull secrets it needs exist in the
 *    DaemonSet's OWN namespace. A pod cannot reference a Secret from another
 *    namespace, and a server installed into an environment namespace keeps its
 *    generated docker-registry Secret there — so that image is dropped rather
 *    than listed and left in ImagePullBackOff forever. Dropped images are
 *    named in a warning (once per distinct set, not once per tick), because
 *    the alternative is a cache that silently stops caching.
 *  - The rollout replaces every node at once (see the updateStrategy in
 *    {@link buildPrepullDaemonSet}), so a pod that never becomes Ready — a tag
 *    deleted from its registry, say — cannot freeze the fleet on an old image
 *    set.
 *
 * Advanced YAML may override the configured image. Once its Deployment exists,
 * the reconciler reads the resolved live pod template and caches that image
 * rather than warming an unrelated configured one.
 */

/**
 * The exact Role rule an operator must add when the reconcile is refused. It
 * is quoted verbatim into the one warning a 403 produces, so the fix can be
 * applied from the log line alone — the chart grants precisely this.
 */
const MCP_IMAGE_PREPULL_RBAC_RULE =
  '- apiGroups: ["apps"]\n  resources: ["daemonsets"]\n  verbs: ["get", "list", "create", "update", "patch", "delete"]';

/** `<release>-mcp-image-prepuller`. */
const DAEMONSET_NAME_SUFFIX = "mcp-image-prepuller";

/**
 * How much of the name is left for the release. The DaemonSet's name is also a
 * label VALUE (`app`, which its own selector matches on), and label values stop
 * at 63 characters — a limit Helm's own 53-character release names can exceed
 * once the suffix is added.
 */
const RELEASE_PREFIX_MAX_LENGTH = 63 - `-${DAEMONSET_NAME_SUFFIX}`.length;

/** Helm's `app.kubernetes.io/instance` is the release name. */
const RELEASE_INSTANCE_LABEL = "app.kubernetes.io/instance";
const PLATFORM_NAME_LABEL = "app.kubernetes.io/name";
const PLATFORM_NAME = "archestra-platform";
const PLATFORM_NAME_SELECTOR = `${PLATFORM_NAME_LABEL}=${PLATFORM_NAME}`;

/**
 * Fingerprint of the pod template this process wants, stamped on the object it
 * writes. A DaemonSet read back from the API server is thick with defaults we
 * never sent, so comparing objects field by field would report a difference on
 * every pass and rewrite the DaemonSet forever; comparing what we last asked
 * for against what we would ask for now is the claim we actually care about.
 */
const SPEC_HASH_ANNOTATION = "archestra.io/prepull-spec-hash";

/**
 * Per-image refresh generations, a JSON `{image: n}` map stamped INSIDE the
 * pod template, so bumping one rolls a pod on every node. The live object is
 * the only store of this state: every pass folds the map it reads back into
 * the spec it wants, which is what keeps replicas that never saw a refresh
 * agreeing with the one that did instead of writing the fleet back to
 * generation zero. An image with a generation pulls with `Always` — its tag
 * has been declared mutable by an explicit refresh, and a rolled pod that
 * skipped the pull because *an* image of that name is present would keep
 * exactly the stale cache the refresh was meant to purge. Entries leave the
 * map when their image leaves the fleet.
 */
const REFRESH_GENERATIONS_ANNOTATION =
  "archestra.io/prepull-refresh-generations";

const MANAGED_LABELS = {
  "app.kubernetes.io/managed-by": "archestra",
  "app.kubernetes.io/component": "mcp-image-prepuller",
} as const;

/**
 * Every node is updated at once, which for this DaemonSet is the only correct
 * setting.
 *
 * The default is `maxUnavailable: 1`: the rollout moves to the second node
 * only once the first node's pod is Ready. Nothing about this pod is worth
 * waiting on — it serves no traffic and nothing reads its readiness — and the
 * wait is actively harmful, because an image that will not pull fails on EVERY
 * node identically. One deleted tag would therefore stop the rollout at the
 * first node and pin the whole fleet to that image set until an operator
 * noticed. Any fraction below 100% only changes how much of the fleet freezes.
 *
 * The cost of 100% is that a spec change restarts the pre-puller everywhere at
 * once. Images already pulled stay in the node's cache, so nothing that
 * hibernation depends on is lost in that window.
 */
const PREPULL_UPDATE_STRATEGY: k8s.V1DaemonSetUpdateStrategy = {
  type: "RollingUpdate",
  rollingUpdate: { maxUnavailable: "100%" },
};

const PREPULL_VOLUME_NAME = "prepull";
const PREPULL_MOUNT_PATH = "/prepull";
/** busybox invoked through this name behaves as `true` and exits 0. */
const PREPULL_NOOP_BINARY = `${PREPULL_MOUNT_PATH}/true`;
/**
 * The statically linked multi-call binary inside the official busybox image
 * the bootstrap container runs from ({@link getMcpImagePrepullConfig}'s
 * `bootstrapImage`). Static linking is the point: the copy is exec'd inside
 * arbitrary target images, which may use a different libc or ship no shell.
 */
const BUSYBOX_PATH = "/bin/busybox";

/**
 * How long a burst of writes is collected before one reconcile runs. Installing
 * a dozen servers, or a catalog refresh that redeploys every install of a
 * multitenant catalog, must cost one DaemonSet rewrite rather than a dozen.
 */
const RECONCILE_DEBOUNCE_MS = 10_000;

/**
 * The floor under the event triggers. Images also change for reasons no
 * trigger fires on — a catalog edited straight in the database, a reconcile
 * that failed transiently — and a cache that is one tick stale costs nothing.
 */
const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * What this replica read about its own surroundings: the scheduling
 * constraints MCP workloads run under.
 *
 * An absent field means the platform pod genuinely has none — a cluster
 * without a nodeSelector or a taint is ordinary and must still converge. The
 * only way to say "I could not find out" is to produce no facts at all
 * (`null`), which every replica must treat as "write nothing this pass": a
 * replica that guessed instead would write a spec its healthy peers disagree
 * with, and the two would replace the DaemonSet — restarting a pod on EVERY
 * node — past each other forever. See {@link McpImagePrepuller.readPlatformPod}.
 */
interface PlatformPodFacts {
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
}

/** One entry of the fleet the DaemonSet has to cache for. */
interface PrepullSource {
  image: string;
  /** Names of Secrets in the DaemonSet's namespace that authorize the pull. */
  pullSecretNames?: readonly string[];
  /**
   * Why this particular install's image cannot be pulled from the DaemonSet's
   * namespace — set only when that is known, and it only ever means a pull
   * secret the namespace does not hold. The image is still cached when some
   * OTHER install contributes it with credentials that do resolve here.
   */
  unresolvedPullSecret?: string;
}

/** An image left out of the DaemonSet, and the reason an operator needs. */
interface DroppedPrepullImage {
  image: string;
  reason: string;
}

/**
 * Whether this deployment offers pre-pulling at all: idle hibernation is
 * offered (beta flag on, not hard-disabled) and the operator has not thrown
 * the pre-pull kill switch. Cheap and synchronous on purpose — it is what
 * keeps a deployment that has opted out from making any Kubernetes call.
 */
function isMcpImagePrepullOffered(): boolean {
  return (
    isIdleHibernationOffered() && config.orchestrator.mcpImagePrepull.enabled
  );
}

/**
 * The distinct images worth caching, plus the union of the pull secrets that
 * authorize them.
 *
 * Bare, node-local image names are dropped: `getMcpImagePullPolicy` gives them
 * `Never` precisely because no registry serves them, so an init container
 * naming one would either find it already on the node (nothing gained) or fail
 * (everything after it lost).
 *
 * An image whose pull secret this namespace does not hold is dropped for the
 * same reason, and reported: listing it would put one init container in
 * ImagePullBackOff on every node forever, and init containers run in order, so
 * every image sorted after it would stop caching too.
 *
 * Both lists are sorted, and that is load-bearing rather than cosmetic: the
 * DaemonSet's pod template is compared against the last one written, so any
 * order that leaked out of a Map or a database read would rewrite the object —
 * and restart a pod on every node — on every single reconcile.
 *
 * @public — the image-set rule, exercised directly by its tests
 */
export function selectPrepullImages(sources: readonly PrepullSource[]): {
  images: string[];
  pullSecretNames: string[];
  dropped: DroppedPrepullImage[];
} {
  const secretsByPullableImage = new Map<string, Set<string>>();
  const reasonByImage = new Map<string, string>();

  for (const source of sources) {
    const image = source.image?.trim();
    if (!image) continue;
    if (getMcpImagePullPolicy(image) === "Never") continue;

    if (source.unresolvedPullSecret) {
      // Keep the first reason only: one line an operator can act on beats a
      // list of every install that shares the image.
      if (!reasonByImage.has(image)) {
        reasonByImage.set(image, source.unresolvedPullSecret);
      }
      continue;
    }

    let secrets = secretsByPullableImage.get(image);
    if (!secrets) {
      secrets = new Set<string>();
      secretsByPullableImage.set(image, secrets);
    }
    for (const name of source.pullSecretNames ?? []) {
      const trimmed = name.trim();
      if (trimmed) secrets.add(trimmed);
    }
  }

  const pullSecretNames = new Set<string>();
  for (const secrets of secretsByPullableImage.values()) {
    for (const name of secrets) pullSecretNames.add(name);
  }

  const dropped: DroppedPrepullImage[] = [];
  for (const image of sortedStrings(reasonByImage.keys())) {
    // Two installs can share an image and only one of them be reachable from
    // here; that one still caches it for both.
    if (secretsByPullableImage.has(image)) continue;
    dropped.push({ image, reason: reasonByImage.get(image) as string });
  }

  return {
    images: sortedStrings(secretsByPullableImage.keys()),
    pullSecretNames: sortedStrings(pullSecretNames),
    dropped,
  };
}

/**
 * Build the DaemonSet for an image set. Pure and total: the same arguments
 * always produce a byte-identical object, which is what makes an unchanged
 * fleet a no-op reconcile.
 *
 * @public — the desired-state builder, exercised directly by its tests
 */
export function buildPrepullDaemonSet(params: {
  name: string;
  namespace: string;
  /** Already filtered and sorted by {@link selectPrepullImages}. */
  images: readonly string[];
  pullSecretNames: readonly string[];
  /**
   * Dedicated image for the DaemonSet's own containers (the noop bootstrap
   * and the keepalive) — the pinned official busybox by default, and NEVER
   * the configurable MCP server base image: its contents are an operator's
   * choice, and a base image without the expected binary wedges every
   * pre-pull pod in init.
   */
  bootstrapImage: string;
  nodeSelector?: Record<string, string> | null;
  tolerations?: readonly k8s.V1Toleration[] | null;
  /** See {@link REFRESH_GENERATIONS_ANNOTATION}; absent entries mean never refreshed. */
  refreshGenerations?: Readonly<Record<string, number>>;
  /**
   * The platform Deployment, so Kubernetes deletes this DaemonSet when the
   * release goes. Helm cannot: the object is not part of the chart.
   */
  ownerReferences?: readonly k8s.V1OwnerReference[] | null;
  priorityClassName?: string;
  resources: {
    requests: { cpu: string; memory: string };
    limits: { memory: string };
  };
}): k8s.V1DaemonSet {
  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: PREPULL_VOLUME_NAME, mountPath: PREPULL_MOUNT_PATH },
  ];
  const resources: k8s.V1ResourceRequirements = {
    requests: {
      cpu: params.resources.requests.cpu,
      memory: params.resources.requests.memory,
    },
    limits: { memory: params.resources.limits.memory },
  };

  const initContainers: k8s.V1Container[] = [
    {
      name: "bootstrap",
      image: params.bootstrapImage,
      imagePullPolicy: getMcpImagePullPolicy(params.bootstrapImage),
      command: ["/bin/cp", BUSYBOX_PATH, PREPULL_NOOP_BINARY],
      volumeMounts,
      resources,
    },
    ...params.images.map((image, index) => ({
      name: prepullContainerName(image, index),
      image,
      // The pull is the work. `IfNotPresent` is what makes a node that already
      // holds the image cost nothing, which is most nodes most of the time —
      // except an image an admin has explicitly refreshed, whose tag is
      // thereby known to move: `IfNotPresent` would see the OLD image in the
      // node's cache and skip the very pull the refresh asked for.
      imagePullPolicy: params.refreshGenerations?.[image]
        ? "Always"
        : "IfNotPresent",
      command: [PREPULL_NOOP_BINARY],
      volumeMounts,
      resources,
    })),
  ];

  const podLabels = { app: params.name, ...MANAGED_LABELS };
  const refreshGenerations = params.refreshGenerations ?? {};

  const template: k8s.V1PodTemplateSpec = {
    metadata: {
      labels: podLabels,
      // Only when non-empty: an empty-but-present annotation would change the
      // fingerprint of every existing fleet and roll it once for nothing.
      ...(Object.keys(refreshGenerations).length > 0
        ? {
            annotations: {
              [REFRESH_GENERATIONS_ANNOTATION]: JSON.stringify(
                sortedRecord(refreshGenerations),
              ),
            },
          }
        : {}),
    },
    spec: {
      // Nothing here talks to the API server.
      automountServiceAccountToken: false,
      volumes: [{ name: PREPULL_VOLUME_NAME, emptyDir: {} }],
      initContainers,
      containers: [
        {
          // Holds the pod Running once the pulls are done, so the DaemonSet
          // keeps its slot on the node instead of being restarted forever.
          name: "keepalive",
          image: params.bootstrapImage,
          imagePullPolicy: getMcpImagePullPolicy(params.bootstrapImage),
          command: ["/bin/sh", "-c", "while true; do sleep 3600; done"],
          resources,
        },
      ],
      ...(params.priorityClassName
        ? { priorityClassName: params.priorityClassName }
        : {}),
      ...(params.nodeSelector && Object.keys(params.nodeSelector).length > 0
        ? { nodeSelector: sortedRecord(params.nodeSelector) }
        : {}),
      ...(params.tolerations?.length
        ? {
            tolerations: params.tolerations.map((toleration) => ({
              ...toleration,
            })),
          }
        : {}),
      ...(params.pullSecretNames.length > 0
        ? {
            imagePullSecrets: params.pullSecretNames.map((name) => ({ name })),
          }
        : {}),
    },
  };

  const selector: k8s.V1LabelSelector = { matchLabels: { app: params.name } };

  return {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: { app: params.name, ...MANAGED_LABELS },
      annotations: {
        // The owner is deliberately outside the fingerprint: it says who
        // deletes this object, not what runs in it, and folding it in would
        // roll a pod on every node the first time an owner is adopted.
        [SPEC_HASH_ANNOTATION]: fingerprint({
          selector,
          updateStrategy: PREPULL_UPDATE_STRATEGY,
          template,
        }),
      },
      ...(params.ownerReferences?.length
        ? {
            ownerReferences: params.ownerReferences.map((owner) => ({
              ...owner,
            })),
          }
        : {}),
    },
    spec: { selector, updateStrategy: PREPULL_UPDATE_STRATEGY, template },
  };
}

/**
 * Owns the DaemonSet: when it is written, when it is left alone, and when it
 * is removed. One per runtime manager.
 */
export class McpImagePrepuller {
  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly rbacApi?: k8s.RbacAuthorizationV1Api;
  private readonly namespace: string;
  private readonly platformNamespace: string;

  private tickTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private inFlight = false;
  private rerunRequested = false;
  private stopped = false;
  /**
   * Images refreshed since the last COMMITTED reconcile — the undelivered
   * triggers, not the state. The state (which generation each image is on)
   * lives on the live DaemonSet, where every replica can read it; this set
   * only carries "bump it once" from the request that asked to the pass that
   * writes, and survives a failed pass by not being consumed.
   */
  private pendingRefreshImages = new Set<string>();
  /**
   * The platform Deployment this release's DaemonSet is owned by, once a read
   * has produced one. Cached only from a read that succeeded: an ownerReference
   * is a UID, and a wrong UID has Kubernetes delete the object immediately.
   */
  private ownerReferences?: k8s.V1OwnerReference[];
  /**
   * Latched when the API server refuses us. Pre-pulling then stops for the
   * lifetime of the process: the fix is a Role change, and granting it means a
   * chart upgrade, which rolls this pod anyway. Latching is what keeps a
   * missing rule from becoming a 403 every tick forever.
   */
  private rbacDenied = false;
  /**
   * The set of images last reported as un-cacheable. A permanent condition —
   * a private-registry server in another namespace — must warn when it appears
   * and when it changes, not on every tick for the life of the process.
   */
  private droppedImagesFingerprint = "";
  /**
   * Whether the last platform-pod read failed, so the pause it causes is
   * reported once rather than every tick — and again if it recurs after a
   * recovery.
   */
  private platformPodUnreadable = false;

  constructor(deps: {
    coreApi: k8s.CoreV1Api;
    appsApi: k8s.AppsV1Api;
    rbacApi?: k8s.RbacAuthorizationV1Api;
    namespace: string;
    platformNamespace?: string;
  }) {
    this.coreApi = deps.coreApi;
    this.appsApi = deps.appsApi;
    this.rbacApi = deps.rbacApi;
    this.namespace = deps.namespace;
    this.platformNamespace = deps.platformNamespace ?? deps.namespace;
  }

  /**
   * Begin reconciling. A deployment that does not offer pre-pulling never
   * arms a timer, so it never makes a Kubernetes call at all.
   */
  start(): void {
    if (this.stopped || this.tickTimer) return;
    if (!isMcpImagePrepullOffered()) {
      logger.info("MCP image pre-pulling is disabled by configuration");
      this.removeDaemonSetWhileDisabled();
      return;
    }
    if (!prepullDaemonSetName()) {
      // Said once, at startup, because the value comes from the environment
      // and will not appear later in this process's life.
      logger.warn(
        "MCP image pre-pulling is disabled: this deployment did not set ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME, so the pre-pull DaemonSet has no name it can be safely created, upgraded and removed under. The Helm chart sets it; hibernation and everything else keep working without it.",
      );
      return;
    }
    this.tickTimer = setInterval(
      () => this.requestReconcile(),
      RECONCILE_INTERVAL_MS,
    );
    this.tickTimer.unref?.();
    this.requestReconcile();
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /**
   * Note that the image set may have changed — an install, an uninstall, a
   * catalog image refresh. Returns immediately; the reconcile it schedules is
   * debounced, so a burst of writes costs one pass, and it is never awaited by
   * the caller that triggered it.
   */
  requestReconcile(): void {
    if (this.stopped || this.rbacDenied) return;
    if (!isMcpImagePrepullOffered()) return;
    // Collapse into the pass already scheduled rather than pushing it back:
    // a steady stream of installs must still get a reconcile, not starve one.
    if (this.debounceTimer) return;

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runReconcile();
    }, RECONCILE_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * An admin refreshed this image. The workload's own rollout pulls it fresh
   * on whichever node its pod lands; this is what re-pulls it on every OTHER
   * node the fleet has cached it on, by bumping the image's refresh
   * generation in the DaemonSet template — which rolls the fleet — and
   * keeping that image's pull policy on `Always` from then on, so later
   * rollouts keep an explicitly-mutable tag honest instead of trusting
   * whatever the node already holds.
   */
  noteImageRefreshed(dockerImage: string | null | undefined): void {
    // The same fallback collectSources applies: an install with no custom
    // image runs — and therefore refreshed — the base image.
    const image = dockerImage?.trim() || config.orchestrator.mcpServerBaseImage;
    this.pendingRefreshImages.add(image);
    this.requestReconcile();
  }

  /**
   * One reconcile, awaited. Never throws and never rejects — every caller of
   * this class is on a path (startup, an install, a timer) that pre-pulling is
   * not allowed to break.
   *
   * @public — the reconcile itself, driven directly by its tests
   */
  async reconcileNow(): Promise<void> {
    if (this.stopped || this.rbacDenied) return;
    if (!isMcpImagePrepullOffered()) return;

    // Nothing is created, read or deleted under a name we are not sure of: an
    // object written under the wrong name is one nothing will ever look for
    // again. This costs no API call, so a deployment that never tells us its
    // release stays completely inert.
    const name = prepullDaemonSetName();
    if (!name) return;

    // Every write below — the create, the replace, the delete — is derived
    // from this one read, so a replica that cannot make it must make no write
    // at all. Guessing would be worse than doing nothing: its guess differs
    // from what its healthy peers write, and the two replace the DaemonSet
    // past each other on every pass, rolling a pod on every node each time.
    const platform = await this.readPlatformPod();
    if (!platform) return;

    try {
      // One read serves the whole pass: the desired spec folds in state the
      // live object carries (the refresh generations), and the replace in
      // applyDaemonSet needs its resourceVersion.
      const existing = await this.readDaemonSet(name);
      const pendingRefreshes = [...this.pendingRefreshImages];
      const desired = await this.buildDesired(
        name,
        platform,
        existing,
        pendingRefreshes,
      );
      // "unknown" is not "none": a pass that could not resolve what it needs
      // makes no write at all, where "none" genuinely means nothing is left
      // to cache and the DaemonSet should go.
      if (desired === "unknown") return;
      if (desired === "none") await this.deleteDaemonSet(name);
      else await this.applyDaemonSet(desired, existing);
      // Consumed only by a pass that committed — a throw above leaves the
      // trigger in place for the next pass to deliver.
      for (const image of pendingRefreshes) {
        this.pendingRefreshImages.delete(image);
      }
    } catch (error) {
      if (this.noteRbacDenial(error)) return;
      logger.warn(
        { err: error, daemonSet: name, namespace: this.namespace },
        "MCP image pre-pull reconcile failed; the node image cache may be stale",
      );
    }
  }

  private async runReconcile(): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.reconcileNow();
    } finally {
      this.inFlight = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.requestReconcile();
      }
    }
  }

  /**
   * The DaemonSet this reconcile wants, or `null` when it wants none — the
   * organization has not enabled hibernation (pre-pulling exists only to serve
   * it), or there is no registry-backed image to cache.
   */
  private async buildDesired(
    name: string,
    platform: PlatformPodFacts,
    existing: k8s.V1DaemonSet | undefined,
    pendingRefreshes: readonly string[],
  ): Promise<k8s.V1DaemonSet | "none" | "unknown"> {
    if (!(await isPrepullWanted())) return "none";

    const sources = await this.collectSources();
    if (sources === null) return "unknown";

    const { images, pullSecretNames, dropped } = selectPrepullImages(sources);
    this.reportDroppedImages(dropped);
    if (images.length === 0) return "none";

    const prepull = config.orchestrator.mcpImagePrepull;
    return buildPrepullDaemonSet({
      name,
      namespace: this.namespace,
      images,
      pullSecretNames: Array.from(
        new Set([...pullSecretNames, ...prepull.bootstrapImagePullSecrets]),
      ),
      refreshGenerations: collectRefreshGenerations({
        existing,
        images,
        pendingRefreshes,
      }),
      bootstrapImage: prepull.bootstrapImage,
      // Land on the node pools MCP servers themselves use: caching an image on
      // a node no MCP server can be scheduled onto warms nothing.
      nodeSelector: platform.nodeSelector,
      tolerations: platform.tolerations,
      ownerReferences: await this.resolveOwnerReferences(),
      priorityClassName: prepull.priorityClassName,
      resources: prepull.resources,
    });
  }

  /**
   * A release-owned Role in the MCP namespace, as an ownerReference, so the
   * cluster's garbage collector deletes the runtime-written DaemonSet when the
   * release is uninstalled. Same-namespace ownership also works when MCP pods
   * run outside the platform release namespace.
   *
   * `undefined` — no owner, and the DaemonSet is still written — in the two
   * cases where there is honestly no owner to name:
   *
   * For non-Helm installs without an anchor, the platform Deployment lookup is
   * retained as a best-effort fallback. Nothing is cached from a failed read,
   * so a later pass can still adopt an unowned DaemonSet.
   *
   * `blockOwnerDeletion` stays off deliberately: setting it requires `update`
   * on the owner's `finalizers` subresource, which the platform's Role does not
   * grant, and the API server rejects the whole write without it.
   */
  private async resolveOwnerReferences(): Promise<
    k8s.V1OwnerReference[] | undefined
  > {
    if (this.ownerReferences) return this.ownerReferences;

    const ownerRoleName = config.orchestrator.kubernetes.runtimeOwnerRoleName;
    if (ownerRoleName) {
      try {
        const ownerReferences = await withK8sApiRetry(
          () => resolveRuntimeOwnerReferences(this.rbacApi, this.namespace),
          { label: "mcp-image-prepull-owner-role" },
        );
        if (!ownerReferences) return undefined;
        this.ownerReferences = ownerReferences;
        return this.ownerReferences;
      } catch (error) {
        logger.debug(
          { err: error, namespace: this.namespace, ownerRoleName },
          "Could not read the configured Role that owns the MCP image pre-pull DaemonSet",
        );
        return undefined;
      }
    }

    const release = config.orchestrator.kubernetes.helmReleaseName;
    if (!release || this.platformNamespace !== this.namespace) return undefined;

    try {
      const deployments = await withK8sApiRetry(
        () =>
          this.appsApi.listNamespacedDeployment({
            namespace: this.platformNamespace,
            labelSelector: `${PLATFORM_NAME_SELECTOR},${RELEASE_INSTANCE_LABEL}=${release}`,
          }),
        { label: "mcp-image-prepull-owner" },
      );
      const owner = deployments.items.find(
        (deployment) => deployment.metadata?.uid && deployment.metadata.name,
      );
      if (!owner) return undefined;

      this.ownerReferences = [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: owner.metadata?.name as string,
          uid: owner.metadata?.uid as string,
          controller: false,
          blockOwnerDeletion: false,
        },
      ];
      return this.ownerReferences;
    } catch (error) {
      // An un-owned DaemonSet still caches images. Losing the owner is worth a
      // line, not a paused reconcile.
      logger.debug(
        { err: error, namespace: this.platformNamespace },
        "Could not read the platform Deployment that owns the MCP image pre-pull DaemonSet",
      );
      return undefined;
    }
  }

  /**
   * Read the platform pod this replica lives beside, or `null` when the read
   * failed and the answer is therefore unknown.
   *
   * The prepuller asks the API server itself rather than reusing
   * `fetchPlatformPodNodeSelector`/`fetchPlatformPodTolerations`, because
   * those latch their result for the life of the process — including the
   * `null` they return after a single transient error, which is
   * indistinguishable from the legitimate "this cluster pins nothing". One
   * unlucky read would leave a replica building a constraint-free spec
   * forever, fighting every healthy replica over the DaemonSet.
   *
   * Two outcomes are deliberately NOT unknown, because every replica reaches
   * them alike and so still converges:
   *
   *  - a pod that carries no `nodeSelector` or `tolerations`: an unpinned
   *    cluster is ordinary, and pre-pulling must work there;
   * Failures — throttling, a 5xx, a lost connection, a Role that cannot read
   * pods — are the unknown ones, and they pause pre-pulling until a read gets
   * through instead of writing a guess.
   */
  private async readPlatformPod(): Promise<PlatformPodFacts | null> {
    const podName =
      process.env.POD_NAME ||
      (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster
        ? process.env.HOSTNAME
        : undefined);

    if (podName) {
      try {
        return this.notePlatformPodRead(
          await withK8sApiRetry(
            () =>
              this.coreApi.readNamespacedPod({
                name: podName,
                namespace: this.platformNamespace,
              }),
            { label: "mcp-image-prepull-platform-pod" },
          ),
        );
      } catch (error) {
        // A 404 is an answer, not a failure: this platform does not run in the
        // namespace it schedules MCP servers into. Ask the namespace instead.
        if (!isK8sNotFoundError(error)) {
          return this.notePlatformPodUnreadable(error);
        }
      }
    }

    let pods: { items: k8s.V1Pod[] };
    try {
      pods = await withK8sApiRetry(
        () =>
          this.coreApi.listNamespacedPod({
            namespace: this.platformNamespace,
            labelSelector: PLATFORM_NAME_SELECTOR,
          }),
        { label: "mcp-image-prepull-platform-pods" },
      );
    } catch (error) {
      return this.notePlatformPodUnreadable(error);
    }

    const pod =
      pods.items.find((candidate) => candidate.status?.phase === "Running") ??
      pods.items[0];
    return this.notePlatformPodRead(pod);
  }

  /** A read that got through: clear the pause, and extract what it tells us. */
  private notePlatformPodRead(pod: k8s.V1Pod | undefined): PlatformPodFacts {
    this.platformPodUnreadable = false;
    return {
      nodeSelector: pod?.spec?.nodeSelector,
      tolerations: pod?.spec?.tolerations?.length
        ? pod.spec.tolerations
        : undefined,
    };
  }

  /**
   * A read that did not get through. Says so once — a pause that never lifts
   * is worth an operator's attention, and one line per tick is not.
   */
  private notePlatformPodUnreadable(error: unknown): null {
    const context = { err: error, namespace: this.platformNamespace };
    if (this.platformPodUnreadable) {
      logger.debug(context, "MCP image pre-pull reconcile skipped again");
      return null;
    }
    this.platformPodUnreadable = true;
    logger.warn(
      context,
      "MCP image pre-pulling is paused: the archestra-platform pod could not be read, so this replica cannot tell which nodes MCP servers are scheduled onto. Nothing is created, updated or removed until a read gets through; hibernation and everything else keep working.",
    );
    return null;
  }

  /**
   * The image of every local MCP install, paired with the pull secrets its
   * catalog contributes. Credential-sourced entries resolve to the generated
   * docker-registry Secrets, which are looked up by label rather than
   * recomputed, so the naming rule stays owned by the one place that writes
   * them.
   *
   * Every name is checked against THIS namespace, and an install whose secret
   * is missing here is marked unresolved rather than listed. MCP deployments
   * go to the namespace of their environment, and both kinds of pull secret
   * follow them there: the generated regcred is created beside the deployment,
   * and an operator's "existing" secret has to be. Kubernetes never reads a
   * Secret across namespaces, so naming one we cannot see would produce an
   * init container that can never pull.
   */
  /**
   * The images this reconcile may cache, or `null` when a lookup it needed
   * could not be answered. `null` means "skip this pass", never "cache
   * nothing" — the two are opposite instructions and only one of them
   * deletes the DaemonSet.
   */
  private async collectSources(): Promise<PrepullSource[] | null> {
    const servers = await McpServerModel.findAll();
    const catalogIds = sortedStrings(
      new Set(
        servers
          .map((server) => server.catalogId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (catalogIds.length === 0) return [];

    const catalogs = await InternalMcpCatalogModel.getByIds(catalogIds);

    const sources: PrepullSource[] = [];
    let regcredsByServerId: Map<string, string[]> | undefined;
    // One answer per Secret name for the whole pass: several installs of one
    // registry name the same secret.
    const secretPresence = new Map<string, Promise<boolean>>();
    const liveImages = new Map<string, Promise<string | undefined>>();

    for (const server of servers) {
      const catalog = server.catalogId
        ? catalogs.get(server.catalogId)
        : undefined;
      if (!catalog || catalog.serverType !== "local") continue;

      const localConfig = catalog.localConfig;
      let image =
        localConfig?.dockerImage?.trim() ||
        config.orchestrator.mcpServerBaseImage;
      if (catalog.deploymentSpecYaml) {
        const deploymentName = K8sDeployment.constructDeploymentName(
          server,
          catalog,
        );
        let liveImage = liveImages.get(deploymentName);
        if (!liveImage) {
          liveImage = this.readLiveDeploymentImage(deploymentName);
          liveImages.set(deploymentName, liveImage);
        }
        image = (await liveImage) ?? image;
      }

      const pullSecretNames: string[] = [];
      let needsGeneratedSecrets = false;
      let unresolvedPullSecret: string | undefined;
      for (const entry of localConfig?.imagePullSecrets ?? []) {
        if (entry.source !== "existing") {
          needsGeneratedSecrets = true;
          continue;
        }
        const name = entry.name?.trim();
        if (!name) continue;
        const present = await this.hasSecret(name, secretPresence);
        // Could not find out: abandon the whole pass rather than publish a
        // spec built from a guess.
        if (present === null) return null;
        if (present) {
          pullSecretNames.push(name);
        } else {
          unresolvedPullSecret ??= `image pull secret "${name}" does not exist in this namespace`;
        }
      }
      if (needsGeneratedSecrets) {
        if (regcredsByServerId === undefined) {
          const listed = await this.listGeneratedRegcredSecrets();
          // Could not find out. Abandoning the pass leaves the DaemonSet
          // exactly as it is; carrying on would drop every credential-backed
          // image and, if that emptied the set, delete it.
          if (listed === null) return null;
          regcredsByServerId = listed;
        }
        const generated = regcredsByServerId.get(server.id) ?? [];
        if (generated.length > 0) pullSecretNames.push(...generated);
        else {
          unresolvedPullSecret ??= `the generated image pull secret for MCP server ${server.id} is in another namespace`;
        }
      }

      sources.push({ image, pullSecretNames, unresolvedPullSecret });
    }

    return sources;
  }

  private async readLiveDeploymentImage(
    deploymentName: string,
  ): Promise<string | undefined> {
    try {
      const deployment = await withK8sApiRetry(
        () =>
          this.appsApi.readNamespacedDeployment({
            name: deploymentName,
            namespace: this.namespace,
          }),
        { label: `mcp-image-prepull-source ${deploymentName}` },
      );
      const containers = deployment.spec?.template.spec?.containers ?? [];
      return (
        containers.find(({ name }) => name === "mcp-server")?.image ??
        containers[0]?.image
      )?.trim();
    } catch (error) {
      if (!isK8sNotFoundError(error)) {
        logger.debug(
          { err: error, deploymentName, namespace: this.namespace },
          "Could not read an advanced-YAML deployment image for pre-pulling",
        );
      }
      return undefined;
    }
  }

  /**
   * Whether a Secret of this name exists in the DaemonSet's namespace, asked
   * at most once per name per pass.
   *
   * A read that fails for any other reason answers `null` — not "no". The
   * question is whether we may safely name the Secret in a pod spec, and an
   * unanswered question is neither a yes nor a no. Answering "no" here would
   * drop the image, and dropping every image is what deletes the DaemonSet,
   * so a single throttled read would tear the pre-pull pod off every node and
   * blame a Secret that never moved.
   */
  private hasSecret(
    name: string,
    cache: Map<string, Promise<boolean | null>>,
  ): Promise<boolean | null> {
    let pending = cache.get(name);
    if (!pending) {
      pending = this.readSecretExists(name);
      cache.set(name, pending);
    }
    return pending;
  }

  /**
   * `true` present, `false` genuinely absent (404), `null` we could not find
   * out.
   *
   * The three are deliberately not two. A read that fails is not evidence the
   * Secret is gone: answering "absent" for a 429 drops the image, and an
   * empty image set is what tears the DaemonSet down — so one throttled pass
   * would delete every node's pre-pull pod and blame a Secret that is sitting
   * exactly where it should be. Only a 404 is an answer; everything else is
   * the absence of one, and the caller skips the pass rather than acting on
   * it.
   */
  private async readSecretExists(name: string): Promise<boolean | null> {
    try {
      await withK8sApiRetry(
        () =>
          this.coreApi.readNamespacedSecret({
            name,
            namespace: this.namespace,
          }),
        { label: "mcp-image-prepull-secret" },
      );
      return true;
    } catch (error) {
      if (isK8sNotFoundError(error)) return false;
      logger.debug(
        { err: error, secret: name, namespace: this.namespace },
        "Could not read an MCP image pull secret; skipping this pre-pull pass rather than assuming it is gone",
      );
      return null;
    }
  }

  /**
   * Name the images this reconcile refused to cache, and why — once per
   * distinct set, not once per tick.
   *
   * A log is the surface. The condition is about an image, and the only
   * neighbouring metric (`mcp_server_deployment_status`) is about a server's
   * deployment state, which this changes nothing about: the server still
   * installs, still runs, still wakes. What it loses is the warm cache, so
   * the one thing an operator needs is the image name and the reason, and the
   * fix — move the Secret, or install the server in the platform's namespace —
   * is theirs to make.
   */
  private reportDroppedImages(dropped: readonly DroppedPrepullImage[]): void {
    // Keyed on the set, so a NEW un-cacheable image is still reported, and a
    // permanent one is not reported every ten minutes forever.
    const key = dropped.length > 0 ? fingerprint(dropped) : "";
    if (key === this.droppedImagesFingerprint) return;
    this.droppedImagesFingerprint = key;
    if (dropped.length === 0) return;

    logger.warn(
      { namespace: this.namespace, skipped: dropped },
      `MCP image pre-pulling skipped ${dropped.length} image(s): their image pull secrets are not in namespace ${this.namespace}. ` +
        "A pod can only use pull secrets from its own namespace, so a private-registry server installed into another environment's namespace cannot be cached. " +
        "Those servers keep working; a wake onto a node without the image reaches the container registry.",
    );
  }

  /**
   * The docker-registry Secrets the runtime generated from stored credentials,
   * grouped by install. Only this namespace is listed, because a pod can only
   * reference pull secrets that live beside it.
   */
  private async listGeneratedRegcredSecrets(): Promise<Map<
    string,
    string[]
  > | null> {
    const byServerId = new Map<string, string[]>();
    try {
      const secrets = await withK8sApiRetry(
        () =>
          this.coreApi.listNamespacedSecret({
            namespace: this.namespace,
            labelSelector: "app=mcp-server,type=regcred",
          }),
        { label: "mcp-image-prepull-regcreds" },
      );
      for (const secret of secrets.items) {
        const serverId = secret.metadata?.labels?.["mcp-server-id"];
        const secretName = secret.metadata?.name;
        if (!serverId || !secretName) continue;
        const existing = byServerId.get(serverId);
        if (existing) existing.push(secretName);
        else byServerId.set(serverId, [secretName]);
      }
    } catch (error) {
      // Not "these servers have no credentials" — we do not know what they
      // have. Reporting an empty map would drop every credential-backed image
      // and, if that emptied the set, delete the DaemonSet on a transient 429.
      logger.warn(
        { err: error, namespace: this.namespace },
        "Could not list generated image pull secrets; skipping this MCP image pre-pull pass",
      );
      return null;
    }
    return byServerId;
  }

  /**
   * The one write a DISABLED pre-puller makes: delete its own object. An
   * existing DaemonSet — a keepalive pod on every node, pinned to a frozen
   * image list — would otherwise survive the very switch the chart documents
   * as the way to remove it, until `helm uninstall`, because the disabled
   * state arms no timer and the org-toggle delete path is never reached. One
   * shot per process start; a 404 makes it free on every start after the
   * first, and a deployment that never named a release stays fully inert.
   */
  private removeDaemonSetWhileDisabled(): void {
    const name = prepullDaemonSetName();
    if (!name) return;
    void this.deleteDaemonSet(name).catch((error) => {
      if (this.noteRbacDenial(error)) return;
      logger.warn(
        { err: error, daemonSet: name, namespace: this.namespace },
        "Could not remove the MCP image pre-pull DaemonSet after pre-pulling was disabled",
      );
    });
  }

  /** The live DaemonSet, or `undefined` when it does not exist. */
  private async readDaemonSet(
    name: string,
  ): Promise<k8s.V1DaemonSet | undefined> {
    try {
      return await withK8sApiRetry(
        () =>
          this.appsApi.readNamespacedDaemonSet({
            name,
            namespace: this.namespace,
          }),
        { label: "mcp-image-prepull-read" },
      );
    } catch (error) {
      if (!isK8sNotFoundError(error)) throw error;
      return undefined;
    }
  }

  private async applyDaemonSet(
    desired: k8s.V1DaemonSet,
    existing: k8s.V1DaemonSet | undefined,
  ): Promise<void> {
    const name = desired.metadata?.name as string;

    if (!existing) {
      try {
        await withK8sApiRetry(
          () =>
            this.appsApi.createNamespacedDaemonSet({
              namespace: this.namespace,
              body: desired,
            }),
          { label: "mcp-image-prepull-create" },
        );
      } catch (error) {
        // Another replica got there first; its object is the same object.
        if (!isK8sConflictError(error)) throw error;
        return;
      }
      logger.info(
        {
          daemonSet: name,
          namespace: this.namespace,
          images: desired.spec?.template.spec?.initContainers?.length,
        },
        "Created the MCP image pre-pull DaemonSet",
      );
      return;
    }

    const currentHash = existing.metadata?.annotations?.[SPEC_HASH_ANNOTATION];
    const desiredHash = desired.metadata?.annotations?.[SPEC_HASH_ANNOTATION];
    // A DaemonSet created before its owner could be read has to be adopted, or
    // it stays un-owned forever: nothing else would ever rewrite it, since its
    // spec is already the one we want.
    const owners = desired.metadata?.ownerReferences?.length
      ? desired.metadata.ownerReferences
      : // Never strip an owner an earlier pass established: a read that fails
        // today must not undo the garbage collection set up yesterday.
        existing.metadata?.ownerReferences;
    const ownerUnchanged =
      !owners?.length ||
      owners.every((owner) =>
        existing?.metadata?.ownerReferences?.some(
          (current) => current.uid === owner.uid,
        ),
      );
    if (currentHash === desiredHash && ownerUnchanged) return;

    await withK8sApiRetry(
      () =>
        this.appsApi.replaceNamespacedDaemonSet({
          name,
          namespace: this.namespace,
          body: {
            ...desired,
            metadata: {
              ...desired.metadata,
              resourceVersion: existing?.metadata?.resourceVersion,
              ...(owners?.length ? { ownerReferences: owners } : {}),
            },
          },
        }),
      { label: "mcp-image-prepull-replace" },
    );
    logger.info(
      { daemonSet: name, namespace: this.namespace },
      "Updated the MCP image pre-pull DaemonSet",
    );
  }

  /** Remove the DaemonSet; a 404 is the state we wanted anyway. */
  private async deleteDaemonSet(name: string): Promise<void> {
    try {
      await this.appsApi.deleteNamespacedDaemonSet({
        name,
        namespace: this.namespace,
      });
    } catch (error) {
      if (isK8sNotFoundError(error)) return;
      throw error;
    }
    logger.info(
      { daemonSet: name, namespace: this.namespace },
      "Removed the MCP image pre-pull DaemonSet: nothing left to cache",
    );
  }

  /**
   * Turn a refusal into a single actionable warning and stop. Returns whether
   * the error was one, so the caller skips its own generic logging.
   */
  private noteRbacDenial(error: unknown): boolean {
    if (k8sStatusCode(error) !== 403) return false;
    if (!this.rbacDenied) {
      this.rbacDenied = true;
      this.stop();
      logger.warn(
        { namespace: this.namespace },
        "MCP image pre-pulling is disabled: the platform's Kubernetes Role may not manage DaemonSets. " +
          `Hibernation and every other feature keep working; wakes onto a node without the image will reach the container registry. Add this rule to the Role in namespace ${this.namespace} and restart the platform:\n${MCP_IMAGE_PREPULL_RBAC_RULE}`,
      );
    }
    return true;
  }
}

/**
 * Whether pre-pulling should have a DaemonSet right now. Pre-pulling has no
 * gate of its own beyond the kill switch: it exists to serve idle hibernation,
 * so it follows hibernation's licence and organization toggle exactly, and is
 * re-read every pass so turning hibernation off takes effect without a restart.
 *
 * The three checks are composed here rather than imported because
 * hibernation.ee keeps its equivalent private; they must be kept in step.
 */
async function isPrepullWanted(): Promise<boolean> {
  if (!isMcpImagePrepullOffered()) return false;
  if (!enterpriseTier.isCoreActive()) return false;
  return OrganizationModel.getMcpIdleHibernationEnabled();
}

/**
 * A DNS-1123 label naming which image the init container pulls. The index
 * makes it collision-free without a hash, and readable in `kubectl describe`
 * — which is where an operator looks when one image will not pull.
 */
function prepullContainerName(image: string, index: number): string {
  const tail = image.slice(image.lastIndexOf("/") + 1);
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `pull-${index}-${slug}` : `pull-${index}`;
}

/**
 * The name of this release's pre-pull DaemonSet, or `undefined` when the
 * release is not known.
 *
 * The release comes from the chart, which knows it, rather than from a label
 * on a pod, which has to be read — and a read can fail. Inferring it was a
 * quiet way to strand a DaemonSet: one unlucky read at startup resolved a
 * different name than the healthy replicas resolved, and the cluster then held
 * TWO pre-pullers, pulling every image on every node twice. The second one is
 * named after nothing, so no later reconcile looks for it, no delete removes
 * it, and `helm uninstall` leaves it behind. A name is either known or it is
 * not; there is no approximation of one worth writing an object under.
 */
function prepullDaemonSetName(): string | undefined {
  const release = config.orchestrator.kubernetes.helmReleaseName;
  if (!release) return undefined;
  return `${releaseNamePrefix(release)}-${DAEMONSET_NAME_SUFFIX}`;
}

/**
 * The release name, shortened to what a label value leaves for it. Long names
 * keep a fingerprint of the full one instead of being cut, so two releases
 * that share a 40-character head still get different DaemonSets.
 */
function releaseNamePrefix(release: string): string {
  if (release.length <= RELEASE_PREFIX_MAX_LENGTH) return release;
  const digest = fingerprint(release).slice(0, 8);
  const head = release
    .slice(0, RELEASE_PREFIX_MAX_LENGTH - digest.length - 1)
    .replace(/-+$/, "");
  return `${head}-${digest}`;
}

/** Code-unit order, so the result never depends on the runtime's locale. */
function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of sortedStrings(Object.keys(record))) {
    sorted[key] = record[key] as T;
  }
  return sorted;
}

/**
 * The refresh-generation map the next spec should carry: what the live object
 * already says, pruned to the images still in the fleet, plus one bump per
 * image an admin refreshed since the last committed pass. Folding the live
 * map back in is what keeps replicas convergent — one that never saw the
 * refresh reproduces the map instead of writing the fleet back to generation
 * zero, which would both roll every node again and drop the image back to
 * `IfNotPresent`.
 */
function collectRefreshGenerations(params: {
  existing: k8s.V1DaemonSet | undefined;
  images: readonly string[];
  pendingRefreshes: readonly string[];
}): Record<string, number> {
  const live = parseRefreshGenerations(params.existing);
  const generations: Record<string, number> = {};
  for (const image of params.images) {
    const current = live[image];
    if (
      typeof current === "number" &&
      Number.isFinite(current) &&
      current > 0
    ) {
      generations[image] = Math.floor(current);
    }
  }
  for (const image of params.pendingRefreshes) {
    // A refresh can race the uninstall that removes its image; nothing is
    // left to keep fresh then.
    if (!params.images.includes(image)) continue;
    generations[image] = (generations[image] ?? 0) + 1;
  }
  return generations;
}

/**
 * The live template's generation map, `{}` when absent or unreadable. A
 * hand-mangled annotation must not wedge reconciling: losing the map costs
 * one fleet roll back to `IfNotPresent` and a redundant re-pull at the next
 * refresh, never correctness.
 */
function parseRefreshGenerations(
  existing: k8s.V1DaemonSet | undefined,
): Record<string, unknown> {
  const raw =
    existing?.spec?.template?.metadata?.annotations?.[
      REFRESH_GENERATIONS_ANNOTATION
    ];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The HTTP status of a Kubernetes client error. `@/k8s/shared` keeps its own
 * copy private and exposes only 404/409/transient guards; 403 is the one this
 * module has to act on.
 */
function k8sStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("response" in error) {
    const statusCode = (error as { response?: { statusCode?: unknown } })
      .response?.statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return undefined;
}
