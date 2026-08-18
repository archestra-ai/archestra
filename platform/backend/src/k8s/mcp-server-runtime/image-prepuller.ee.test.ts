// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/**
 * The MCP image pre-puller: which images end up cached, that an unchanged
 * fleet costs nothing, and that a pre-pull which cannot run never becomes
 * anybody else's problem.
 *
 * The reconcile runs for real against a fake Kubernetes API server and real
 * `mcp_server` / `internal_mcp_catalog` rows, because the two mistakes that
 * matter are both invisible to a mocked-out version: a spec that is not
 * byte-stable rewrites the DaemonSet — restarting a pod on EVERY node — on
 * every pass, and a 403 that is not recognized turns a missing Role rule into
 * a warning per tick forever.
 */
import { vi } from "vitest";

// The 403 path's whole contract is the WARNING it produces, and the real
// export is a Proxy no spy can intercept (see test/mocks/logging.ts).
vi.mock("@/logging");

import type { LocalConfigSchema } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import type z from "zod";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { InternalMcpCatalogModel, OrganizationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  buildPrepullDaemonSet,
  McpImagePrepuller,
  selectPrepullImages,
} from "./image-prepuller.ee";
import {
  resetPlatformNodeSelectorCache,
  resetPlatformTolerationsCache,
} from "./k8s-deployment";

const NAMESPACE = "prepull-test-namespace";
const RELEASE = "my-release";
const DAEMONSET_NAME = `${RELEASE}-mcp-image-prepuller`;
// A dedicated static bootstrap image, never the MCP base image.
const BOOTSTRAP_IMAGE = "mirror.example.com/busybox:1.36-musl";

const NOT_FOUND = { statusCode: 404, message: "not found" };
const THROTTLED = { statusCode: 429, message: "too many requests" };
/**
 * A lost connection: it says nothing about the cluster, which is exactly what
 * makes it dangerous — it is indistinguishable from "this cluster pins
 * nothing" to anything that only sees the absent answer.
 */
const CONNECTION_RESET = Object.assign(new Error("socket hang up"), {
  code: "ECONNRESET",
});
const FORBIDDEN = {
  statusCode: 403,
  message:
    'daemonsets.apps is forbidden: User cannot create resource "daemonsets"',
};

const BASE_RESOURCES = {
  requests: { cpu: "10m", memory: "16Mi" },
  limits: { memory: "64Mi" },
};

describe("selectPrepullImages", () => {
  test("drops bare, node-local image names — no registry serves them", () => {
    // `getMcpImagePullPolicy` gives these `Never` for exactly this reason.
    // An init container naming one would fail on any node that lacks it, and
    // init containers run in sequence: every image after it stops caching.
    const { images } = selectPrepullImages([
      { image: "my-local-build" },
      { image: "mcp-everything:dev" },
      { image: "ghcr.io/acme/weather:1.4" },
      { image: "acme/weather:1.4" },
      { image: "registry.internal:5000/weather" },
    ]);

    expect(images).toEqual([
      "acme/weather:1.4",
      "ghcr.io/acme/weather:1.4",
      "registry.internal:5000/weather",
    ]);
  });

  test("dedupes and sorts, so two identical fleets produce one list", () => {
    const fleetOrder = selectPrepullImages([
      { image: "ghcr.io/acme/b:2" },
      { image: "ghcr.io/acme/a:1" },
      { image: "ghcr.io/acme/b:2" },
    ]);
    const otherOrder = selectPrepullImages([
      { image: "ghcr.io/acme/b:2" },
      { image: "ghcr.io/acme/a:1" },
    ]);

    expect(fleetOrder.images).toEqual(["ghcr.io/acme/a:1", "ghcr.io/acme/b:2"]);
    expect(fleetOrder).toEqual(otherOrder);
  });

  test("unions the pull secrets of the catalogs that contribute images", () => {
    // Private registries are per-server: the DaemonSet pulls all of them from
    // one pod, so it needs every contributing catalog's credentials at once.
    const { pullSecretNames } = selectPrepullImages([
      { image: "ghcr.io/acme/a:1", pullSecretNames: ["ghcr-creds"] },
      {
        image: "quay.io/acme/b:1",
        pullSecretNames: ["quay-creds", "ghcr-creds"],
      },
      { image: "ghcr.io/acme/c:1" },
    ]);

    expect(pullSecretNames).toEqual(["ghcr-creds", "quay-creds"]);
  });

  test("a skipped image does not drag its pull secret along", () => {
    const { images, pullSecretNames } = selectPrepullImages([
      { image: "node-local-only", pullSecretNames: ["unused-creds"] },
      { image: "ghcr.io/acme/a:1", pullSecretNames: ["ghcr-creds"] },
    ]);

    expect(images).toEqual(["ghcr.io/acme/a:1"]);
    expect(pullSecretNames).toEqual(["ghcr-creds"]);
  });

  test("drops an image whose pull secret this namespace cannot resolve", () => {
    // Listing it would leave one init container in ImagePullBackOff on every
    // node — and the images sorted after it never pull at all.
    const { images, pullSecretNames, dropped } = selectPrepullImages([
      { image: "ghcr.io/acme/a:1", pullSecretNames: ["ghcr-creds"] },
      {
        image: "ghcr.io/acme/private:2",
        unresolvedPullSecret: 'image pull secret "env-creds" does not exist',
      },
    ]);

    expect(images).toEqual(["ghcr.io/acme/a:1"]);
    expect(pullSecretNames).toEqual(["ghcr-creds"]);
    expect(dropped).toEqual([
      {
        image: "ghcr.io/acme/private:2",
        reason: 'image pull secret "env-creds" does not exist',
      },
    ]);
  });

  test("keeps a shared image when one install can still pull it", () => {
    // Two installs of the same catalog image, one of them reachable from this
    // namespace: caching it serves both.
    const { images, pullSecretNames, dropped } = selectPrepullImages([
      {
        image: "ghcr.io/acme/shared:1",
        unresolvedPullSecret: "no secret here",
      },
      { image: "ghcr.io/acme/shared:1", pullSecretNames: ["ghcr-creds"] },
    ]);

    expect(images).toEqual(["ghcr.io/acme/shared:1"]);
    expect(pullSecretNames).toEqual(["ghcr-creds"]);
    expect(dropped).toEqual([]);
  });
});

describe("buildPrepullDaemonSet", () => {
  const build = (
    overrides: Partial<Parameters<typeof buildPrepullDaemonSet>[0]> = {},
  ) =>
    buildPrepullDaemonSet({
      name: DAEMONSET_NAME,
      namespace: NAMESPACE,
      images: ["ghcr.io/acme/a:1", "ghcr.io/acme/b:2"],
      pullSecretNames: ["ghcr-creds"],
      bootstrapImage: BOOTSTRAP_IMAGE,
      resources: BASE_RESOURCES,
      ...overrides,
    });

  test("pulls each image through a statically linked busybox copied in first", () => {
    const initContainers = build().spec?.template.spec?.initContainers ?? [];

    expect(initContainers[0]).toMatchObject({
      name: "bootstrap",
      image: BOOTSTRAP_IMAGE,
      command: ["/bin/cp", "/bin/busybox", "/prepull/true"],
    });
    expect(initContainers.slice(1).map((c) => [c.image, c.command])).toEqual([
      ["ghcr.io/acme/a:1", ["/prepull/true"]],
      ["ghcr.io/acme/b:2", ["/prepull/true"]],
    ]);
    // `IfNotPresent` is what makes a node that already holds the image free.
    expect(
      initContainers
        .slice(1)
        .every((c) => c.imagePullPolicy === "IfNotPresent"),
    ).toBe(true);
    // Every init container shares the volume the busybox was copied into.
    expect(
      initContainers.every((c) =>
        c.volumeMounts?.some((m) => m.mountPath === "/prepull"),
      ),
    ).toBe(true);
  });

  test("keeps a sleeping container so the DaemonSet holds its slot", () => {
    const containers = build().spec?.template.spec?.containers ?? [];

    expect(containers).toHaveLength(1);
    expect(containers[0]?.image).toBe(BOOTSTRAP_IMAGE);
    expect(containers[0]?.command?.join(" ")).toContain("sleep");
  });

  test("the same image set builds a byte-identical spec", () => {
    // Not cosmetic: the reconcile compares this against what it last wrote.
    // Any order that leaks out of a Map, a database read, or an object literal
    // makes every pass a rewrite — and a rewrite restarts a pod on every node.
    const first = build({
      nodeSelector: { "topology.kubernetes.io/zone": "a", pool: "mcp" },
      tolerations: [{ key: "mcp", operator: "Exists" }],
    });
    const second = build({
      nodeSelector: { pool: "mcp", "topology.kubernetes.io/zone": "a" },
      tolerations: [{ key: "mcp", operator: "Exists" }],
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("a changed image set changes the fingerprint", () => {
    const before = build();
    const after = build({ images: ["ghcr.io/acme/a:1", "ghcr.io/acme/c:3"] });

    expect(hashOf(after)).not.toBe(hashOf(before));
  });

  test("updates every node at once, so one bad node cannot freeze the fleet", () => {
    // An image that will not pull fails identically on every node, so the
    // default `maxUnavailable: 1` would stop the rollout at the first node and
    // pin the whole fleet to that image set. Nothing waits on these pods'
    // readiness, so there is nothing to protect by rolling slowly.
    expect(build().spec?.updateStrategy).toEqual({
      type: "RollingUpdate",
      rollingUpdate: { maxUnavailable: "100%" },
    });
  });

  test("carries the pull secrets, priority class and scheduling constraints", () => {
    const spec = build({
      priorityClassName: "best-effort",
      nodeSelector: { pool: "mcp" },
      tolerations: [{ key: "mcp", operator: "Exists" }],
    }).spec?.template.spec;

    expect(spec?.imagePullSecrets).toEqual([{ name: "ghcr-creds" }]);
    expect(spec?.priorityClassName).toBe("best-effort");
    expect(spec?.nodeSelector).toEqual({ pool: "mcp" });
    expect(spec?.tolerations).toEqual([{ key: "mcp", operator: "Exists" }]);
  });

  test("a refreshed image pulls with Always, changes the fingerprint, and drags nobody with it", () => {
    const plain = build();
    const refreshed = build({ refreshGenerations: { "ghcr.io/acme/a:1": 1 } });

    const pullPolicies = (refreshed.spec?.template.spec?.initContainers ?? [])
      .slice(1)
      .map((container) => [container.image, container.imagePullPolicy]);
    // The refreshed tag is declared mutable: `IfNotPresent` would see the OLD
    // image in the node cache and skip the very pull the refresh asked for.
    // Its neighbour keeps the cheap policy — one admin refresh must not turn
    // every fleet roll into a registry sweep.
    expect(pullPolicies).toEqual([
      ["ghcr.io/acme/a:1", "Always"],
      ["ghcr.io/acme/b:2", "IfNotPresent"],
    ]);
    // The generation lives in the template, so bumping it IS the fleet roll.
    expect(hashOf(refreshed)).not.toBe(hashOf(plain));
    expect(
      refreshed.spec?.template.metadata?.annotations?.[
        "archestra.io/prepull-refresh-generations"
      ],
    ).toBe(JSON.stringify({ "ghcr.io/acme/a:1": 1 }));
  });

  test("the same generations build a byte-identical spec, whatever their order", () => {
    const first = build({
      refreshGenerations: { "ghcr.io/acme/a:1": 2, "ghcr.io/acme/b:2": 1 },
    });
    const second = build({
      refreshGenerations: { "ghcr.io/acme/b:2": 1, "ghcr.io/acme/a:1": 2 },
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("McpImagePrepuller.reconcileNow", () => {
  let cluster: FakeCluster;
  let prepullEnabled: boolean;
  let betaEnabled: boolean;
  let hardDisabled: boolean;
  let helmReleaseName: string | undefined;
  let ownerConfigMapName: string | undefined;

  beforeEach(() => {
    prepullEnabled = config.orchestrator.mcpImagePrepull.enabled;
    betaEnabled = config.orchestrator.mcpIdleHibernation.betaEnabled;
    hardDisabled = config.orchestrator.mcpIdleHibernation.hardDisabled;
    helmReleaseName = config.orchestrator.kubernetes.helmReleaseName;
    ownerConfigMapName =
      config.orchestrator.kubernetes.runtimeOwnerConfigMapName;

    // The chart tells the backend which release it is. The DaemonSet is named
    // after it, and that name has to be the same on every replica and after
    // every restart.
    config.orchestrator.kubernetes.helmReleaseName = RELEASE;
    config.orchestrator.kubernetes.runtimeOwnerConfigMapName = undefined;

    // Pre-pulling only ever runs where hibernation runs: offered by the
    // deployment, licensed, and opted into by the organization.
    config.orchestrator.mcpImagePrepull.enabled = true;
    config.orchestrator.mcpIdleHibernation.betaEnabled = true;
    config.orchestrator.mcpIdleHibernation.hardDisabled = false;
    vi.spyOn(enterpriseTier, "isCoreActive").mockReturnValue(true);
    vi.spyOn(
      OrganizationModel,
      "getMcpIdleHibernationEnabled",
    ).mockResolvedValue(true);

    // The platform pod spec is cached for the process, and these tests each
    // stand up their own fake cluster to read it from.
    resetPlatformNodeSelectorCache();
    resetPlatformTolerationsCache();
    vi.mocked(logger.warn).mockClear();

    cluster = new FakeCluster();
  });

  afterEach(() => {
    config.orchestrator.mcpImagePrepull.enabled = prepullEnabled;
    config.orchestrator.mcpIdleHibernation.betaEnabled = betaEnabled;
    config.orchestrator.mcpIdleHibernation.hardDisabled = hardDisabled;
    config.orchestrator.kubernetes.helmReleaseName = helmReleaseName;
    config.orchestrator.kubernetes.runtimeOwnerConfigMapName =
      ownerConfigMapName;
    vi.restoreAllMocks();
  });

  test("caches every registry-backed image of the local fleet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "quay.io/acme/files:2.0",
    });
    // Node-local: nothing to pull, and it would stall the images after it.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "locally-built-server",
    });
    // Remote servers have no deployment at all.
    await makeMcpServer({});

    await prepuller(cluster).reconcileNow();

    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual([
      "ghcr.io/acme/weather:1.4",
      "quay.io/acme/files:2.0",
    ]);
    expect(cluster.namespaceOf(DAEMONSET_NAME)).toBe(NAMESPACE);
  });

  test("caches the resolved advanced-YAML image instead of the configured fallback", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        dockerImage: "ghcr.io/acme/configured:1",
      },
      deploymentSpecYaml: [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        "        - name: mcp-server",
        "          image: ghcr.io/acme/from-yaml:2",
      ].join("\n"),
    });
    await makeMcpServer({ catalogId: catalog.id });
    cluster.deploymentImage = "ghcr.io/acme/from-yaml:2";

    await prepuller(cluster).reconcileNow();

    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual([
      "ghcr.io/acme/from-yaml:2",
    ]);
  });

  test("its own containers run the dedicated bootstrap image, never the MCP base image", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // The wedge this pins: the configured MCP base image is an operator's
    // choice (a pinned older release, a custom derivative) and has no say
    // over the DaemonSet's own containers — a base image without the
    // bootstrap's binary used to leave every pre-pull pod stuck in init.
    const baseImage = config.orchestrator.mcpServerBaseImage;
    config.orchestrator.mcpServerBaseImage = "ghcr.io/acme/pinned-base:0.0.1";
    try {
      await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
        dockerImage: "ghcr.io/acme/weather:1.4",
      });
      await prepuller(cluster).reconcileNow();

      const spec = cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec;
      const bootstrap = spec?.initContainers?.[0];
      const keepalive = spec?.containers?.[0];
      for (const container of [bootstrap, keepalive]) {
        expect(container?.image).toBe(
          config.orchestrator.mcpImagePrepull.bootstrapImage,
        );
        expect(container?.image).not.toBe(
          config.orchestrator.mcpServerBaseImage,
        );
      }
    } finally {
      config.orchestrator.mcpServerBaseImage = baseImage;
    }
  });

  test("a burst of installs is collected into one reconcile", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    const runtime = prepuller(cluster);

    vi.useFakeTimers();
    // Installing a bundle of servers, or a catalog reinstall that redeploys
    // every install of a multitenant catalog: one DaemonSet rewrite, not N.
    for (let i = 0; i < 5; i++) runtime.requestReconcile();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();

    await vi.waitFor(() => expect(cluster.writes).toEqual(["create"]));
    expect(cluster.daemonSetCalls.filter((call) => call === "read")).toEqual([
      "read",
    ]);
    runtime.stop();
  });

  test("an unchanged fleet is a no-op: the second pass writes nothing", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    expect(cluster.writes).toEqual(["create"]);

    await runtime.reconcileNow();

    // A DaemonSet rewrite restarts a pod on every node in the cluster. Doing
    // that every ten minutes because the spec is not stable would be worse
    // than not pre-pulling at all.
    expect(cluster.writes).toEqual(["create"]);
  });

  test("a new install rewrites the DaemonSet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    const runtime = prepuller(cluster);
    await runtime.reconcileNow();

    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/files:2.0",
    });
    await runtime.reconcileNow();

    expect(cluster.writes).toEqual(["create", "replace"]);
    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual([
      "ghcr.io/acme/files:2.0",
      "ghcr.io/acme/weather:1.4",
    ]);
  });

  test("a refresh rolls an unchanged fleet and pins the refreshed tag to Always", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:latest",
    });
    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    expect(cluster.writes).toEqual(["create"]);

    // The workload rollout pulled the moved tag on ONE node. Without this,
    // every other node keeps serving the old digest to any pod that lands
    // there under `IfNotPresent` — an unchanged image SET must still roll.
    runtime.noteImageRefreshed("ghcr.io/acme/weather:latest");
    await runtime.reconcileNow();

    expect(cluster.writes).toEqual(["create", "replace"]);
    expect(generationsOf(cluster)).toBe(
      JSON.stringify({ "ghcr.io/acme/weather:latest": 1 }),
    );
    expect(pullPolicyOf(cluster, "ghcr.io/acme/weather:latest")).toBe("Always");

    // Delivered once: the trigger was consumed, so the next pass is a no-op
    // rather than a fresh roll of every node in the cluster.
    await runtime.reconcileNow();
    expect(cluster.writes).toEqual(["create", "replace"]);
    runtime.stop();
  });

  test("a replica that never saw the refresh reproduces the fleet's generations", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:latest",
    });
    const refreshedReplica = prepuller(cluster);
    await refreshedReplica.reconcileNow();
    refreshedReplica.noteImageRefreshed("ghcr.io/acme/weather:latest");
    await refreshedReplica.reconcileNow();
    expect(cluster.writes).toEqual(["create", "replace"]);

    // A peer with no memory of the refresh folds the live object's map back
    // into its own desired spec. Anything else is the two replicas replacing
    // the DaemonSet past each other — rolling every node — forever.
    await prepuller(cluster).reconcileNow();

    expect(cluster.writes).toEqual(["create", "replace"]);
    expect(generationsOf(cluster)).toBe(
      JSON.stringify({ "ghcr.io/acme/weather:latest": 1 }),
    );
    refreshedReplica.stop();
  });

  test("a failed pass keeps the refresh trigger for the next one", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:latest",
    });
    const runtime = prepuller(cluster);
    await runtime.reconcileNow();

    runtime.noteImageRefreshed("ghcr.io/acme/weather:latest");
    cluster.failDaemonSetsWith = { statusCode: 500, message: "etcd sneezed" };
    await runtime.reconcileNow();
    expect(generationsOf(cluster)).toBeUndefined();

    cluster.failDaemonSetsWith = null;
    await runtime.reconcileNow();

    // The refresh was asked for once and delivered once — a pass dying must
    // not eat it.
    expect(generationsOf(cluster)).toBe(
      JSON.stringify({ "ghcr.io/acme/weather:latest": 1 }),
    );
    runtime.stop();
  });

  test("an image that leaves the fleet takes its refresh generation along", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/acme/weather:latest" },
    });
    await makeMcpServer({ catalogId: catalog.id });
    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    runtime.noteImageRefreshed("ghcr.io/acme/weather:latest");
    await runtime.reconcileNow();
    expect(generationsOf(cluster)).toBe(
      JSON.stringify({ "ghcr.io/acme/weather:latest": 1 }),
    );

    // The catalog moves to a new image: the old tag has nothing left to keep
    // fresh, and the new one has never been refreshed.
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { dockerImage: "ghcr.io/acme/weather:2.0" },
    });
    await runtime.reconcileNow();

    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual([
      "ghcr.io/acme/weather:2.0",
    ]);
    expect(generationsOf(cluster)).toBeUndefined();
    expect(pullPolicyOf(cluster, "ghcr.io/acme/weather:2.0")).toBe(
      "IfNotPresent",
    );
    runtime.stop();
  });

  test("unions the pull secrets of the catalogs contributing images", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
      imagePullSecrets: [{ source: "existing", name: "ghcr-creds" }],
    });
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "quay.io/acme/files:2.0",
      imagePullSecrets: [
        { source: "existing", name: "quay-creds" },
        { source: "existing", name: "ghcr-creds" },
      ],
    });
    cluster.addSecret("ghcr-creds");
    cluster.addSecret("quay-creds");

    await prepuller(cluster).reconcileNow();

    expect(cluster.pullSecretsOf(DAEMONSET_NAME)).toEqual([
      { name: "ghcr-creds" },
      { name: "quay-creds" },
    ]);
  });

  test("skips an image whose named pull secret is in another namespace", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // `existing` names are written for the DEPLOYMENT's namespace, which for
    // any non-default environment is not this one. Kubernetes never reads a
    // Secret across namespaces, so this image can never be pulled here.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/private:1",
      imagePullSecrets: [{ source: "existing", name: "env-only-creds" }],
    });
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/public:2",
    });

    await prepuller(cluster).reconcileNow();

    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual(["ghcr.io/acme/public:2"]);
    expect(cluster.pullSecretsOf(DAEMONSET_NAME)).toEqual([]);
  });

  test("skips an image whose generated regcred is in another namespace", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // The runtime creates the regcred beside the deployment, in the
    // environment's namespace. From here there is no Secret to name at all —
    // and one init container that can never pull stalls every image after it.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/private:1",
      imagePullSecrets: [
        { source: "credentials", server: "ghcr.io", username: "bot" },
      ],
    });
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "zz.ghcr.io/acme/public:2",
    });

    await prepuller(cluster).reconcileNow();

    // Sorted last on purpose: before the fix the un-pullable image came first
    // and took this one down with it.
    expect(cluster.imagesOf(DAEMONSET_NAME)).toEqual([
      "zz.ghcr.io/acme/public:2",
    ]);
  });

  test("names the images it skipped once, not on every tick", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/private:1",
      imagePullSecrets: [{ source: "existing", name: "env-only-creds" }],
    });
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/public:2",
    });
    const warn = vi.mocked(logger.warn);

    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    await runtime.reconcileNow();

    // Silence is the bug this replaces: the operator has no other signal that
    // a server's image is not being cached.
    const skips = prepullSkips(warn);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      namespace: NAMESPACE,
      skipped: [
        {
          image: "ghcr.io/acme/private:1",
          reason: expect.stringContaining("env-only-creds"),
        },
      ],
    });

    // A permanent condition must not warn every ten minutes — but a NEW
    // un-cacheable image is news again.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/private-two:1",
      imagePullSecrets: [{ source: "existing", name: "other-env-creds" }],
    });
    await runtime.reconcileNow();

    expect(prepullSkips(warn)).toHaveLength(2);
  });

  test("resolves credential-sourced secrets to the generated regcred Secrets", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const server = await installLocalServer(
      makeInternalMcpCatalog,
      makeMcpServer,
      {
        dockerImage: "ghcr.io/acme/weather:1.4",
        imagePullSecrets: [
          { source: "credentials", server: "ghcr.io", username: "bot" },
        ],
      },
    );
    cluster.addRegcredSecret(
      `mcp-server-${server.id}-regcred-ghcr-io-bot`,
      server.id,
    );
    cluster.addRegcredSecret("mcp-server-other-regcred-ghcr-io-bot", "other");

    await prepuller(cluster).reconcileNow();

    expect(cluster.pullSecretsOf(DAEMONSET_NAME)).toEqual([
      { name: `mcp-server-${server.id}-regcred-ghcr-io-bot` },
    ]);
  });

  test("removes the DaemonSet when the organization turns hibernation off", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    expect(cluster.has(DAEMONSET_NAME)).toBe(true);

    vi.mocked(OrganizationModel.getMcpIdleHibernationEnabled).mockResolvedValue(
      false,
    );
    await runtime.reconcileNow();

    // Pre-pulling exists only to serve hibernation, so a per-node pod that
    // serves nothing must not keep its slot.
    expect(cluster.has(DAEMONSET_NAME)).toBe(false);
  });

  test("a 403 disables pre-pulling once, names the missing rule, and never throws", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    const warn = vi.mocked(logger.warn);
    cluster.forbidDaemonSets = true;

    const runtime = prepuller(cluster);
    await expect(runtime.reconcileNow()).resolves.toBeUndefined();

    // The whole value of this warning is that an operator can apply the fix
    // from the log line alone, so it must carry the rule verbatim — this is
    // exactly what the chart's Role grants.
    const denials = rbacDenials(warn);
    expect(denials).toHaveLength(1);
    expect(denials[0]).toContain('apiGroups: ["apps"]');
    expect(denials[0]).toContain('resources: ["daemonsets"]');
    expect(denials[0]).toContain(
      'verbs: ["get", "list", "create", "update", "patch", "delete"]',
    );

    // And it stops asking: a missing Role rule must not become a 403 per tick
    // for the life of the process.
    const callsAfterDenial = cluster.daemonSetCalls.length;
    await runtime.reconcileNow();
    runtime.requestReconcile();
    expect(cluster.daemonSetCalls).toHaveLength(callsAfterDenial);
    expect(rbacDenials(warn)).toHaveLength(1);
  });

  test("a reconcile that fails for any other reason is logged, not thrown", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    cluster.failDaemonSetsWith = { statusCode: 422, message: "invalid" };

    // Callers of this are on the startup path and on every install.
    await expect(prepuller(cluster).reconcileNow()).resolves.toBeUndefined();
  });

  test("the kill switch removes an existing DaemonSet, then goes quiet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    // A fleet that was running: the DaemonSet exists on every node.
    const enabledRuntime = prepuller(cluster);
    await enabledRuntime.reconcileNow();
    expect(cluster.has(DAEMONSET_NAME)).toBe(true);

    // The chart documents this switch as the way to remove the per-node pod —
    // an object that survived it until `helm uninstall` would be an orphan
    // pinned to a frozen image list.
    config.orchestrator.mcpImagePrepull.enabled = false;
    const runtime = prepuller(cluster);
    runtime.start();
    await vi.waitFor(() => expect(cluster.has(DAEMONSET_NAME)).toBe(false));

    // And the delete is the ONLY thing a disabled pre-puller does: no timer,
    // no reconcile, no rebuild.
    const callsAfterCleanup = cluster.allCalls.length;
    runtime.requestReconcile();
    await runtime.reconcileNow();
    expect(cluster.allCalls.length).toBe(callsAfterCleanup);
    runtime.stop();
    enabledRuntime.stop();
  });

  test("hibernation's own hard kill switch takes pre-pulling with it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    config.orchestrator.mcpIdleHibernation.hardDisabled = true;

    await prepuller(cluster).reconcileNow();

    expect(cluster.allCalls).toEqual([]);
  });

  test("a fleet with nothing worth caching gets no DaemonSet at all", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // Only node-local images: there is no registry to warm a cache from.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "locally-built-server",
    });

    await prepuller(cluster).reconcileNow();

    expect(cluster.has(DAEMONSET_NAME)).toBe(false);
    expect(cluster.writes).toEqual([]);
  });

  test("inherits the MCP servers' node selector and tolerations", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    cluster.platformNodeSelector = { pool: "mcp" };
    cluster.platformTolerations = [{ key: "mcp", operator: "Exists" }];

    await prepuller(cluster).reconcileNow();

    // Warming an image on a node no MCP server can be scheduled onto warms
    // nothing — and blanket-tolerating everything would put a pod on nodes
    // that were tainted to keep workloads off them.
    const spec = cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec;
    expect(spec?.nodeSelector).toEqual({ pool: "mcp" });
    expect(spec?.tolerations).toEqual([{ key: "mcp", operator: "Exists" }]);
  });

  test("reads scheduling from the platform namespace for a separate MCP namespace", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    cluster.platformNodeSelector = { pool: "mcp" };

    await prepuller(cluster, "platform-namespace").reconcileNow();

    expect(cluster.platformPodReadNamespaces).toEqual(["platform-namespace"]);
    expect(cluster.namespaceOf(DAEMONSET_NAME)).toBe(NAMESPACE);
    expect(
      cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec?.nodeSelector,
    ).toEqual({ pool: "mcp" });
  });

  test("a replica that cannot read the platform pod writes nothing at all", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    const warn = vi.mocked(logger.warn);

    const runtime = prepuller(cluster);
    await replicaPass(runtime, cluster, { platformPodUnreachable: true });

    // Not a create with default scheduling, not a delete: a replica that does
    // not know where MCP servers land does not get to decide anything.
    expect(cluster.writes).toEqual([]);
    expect(cluster.daemonSetCalls).toEqual([]);

    // And the pause is reported once, not once per tick.
    await replicaPass(runtime, cluster, { platformPodUnreachable: true });
    expect(pausedWarnings(warn)).toHaveLength(1);

    // The moment a read gets through, the same replica converges.
    await replicaPass(runtime, cluster);
    expect(cluster.writes).toEqual(["create"]);
  });

  test("a throttled pull-secret read does not delete the DaemonSet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // A server whose image needs a pull secret that DOES exist here.
    cluster.secrets.push({
      metadata: { name: "acme-registry" },
    } as k8s.V1Secret);
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
      imagePullSecrets: [{ source: "existing", name: "acme-registry" }],
    });

    const runtime = prepuller(cluster);
    await replicaPass(runtime, cluster);
    expect(cluster.writes).toEqual(["create"]);

    // Now the API server throttles the Secret read. Answering "absent" would
    // drop the image, and an empty image set is what deletes the DaemonSet —
    // so one 429 would tear the pre-pull pod off every node and blame a Secret
    // that never moved.
    await replicaPass(runtime, cluster, { secretReadsThrottled: true });
    expect(cluster.writes).toEqual(["create"]);
    expect(cluster.daemonSets.size).toBe(1);

    // And it converges again the moment the reads get through.
    await replicaPass(runtime, cluster);
    expect(cluster.writes).toEqual(["create"]);
  });

  test("two replicas converge when only one of them can read the platform pod", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    cluster.platformNodeSelector = { pool: "mcp" };
    cluster.platformTolerations = [{ key: "mcp", operator: "Exists" }];

    // `minReplicas` is 2 in the chart, so this is the normal shape, not an
    // edge case: the two replicas alternate passes over one DaemonSet.
    const healthy = prepuller(cluster);
    const blinded = prepuller(cluster);

    for (let round = 0; round < 3; round++) {
      await replicaPass(healthy, cluster);
      await replicaPass(blinded, cluster, { platformPodUnreachable: true });
    }

    // The blinded replica must never write the constraint-free spec it would
    // otherwise build: the two would then replace the DaemonSet past each
    // other on every pass, restarting a pod on every node each time, forever.
    expect(cluster.writes).toEqual(["create"]);
    const spec = cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec;
    expect(spec?.nodeSelector).toEqual({ pool: "mcp" });
    expect(spec?.tolerations).toEqual([{ key: "mcp", operator: "Exists" }]);
  });

  test("a cluster that pins nothing is an answer, not a mystery", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    // No nodeSelector and no tolerations on the platform pod: an ordinary
    // cluster, and pre-pulling has to work there — "read it and there was
    // none" must not be confused with "could not read it".
    const first = prepuller(cluster);
    const second = prepuller(cluster);
    await replicaPass(first, cluster);
    await replicaPass(second, cluster);
    await replicaPass(first, cluster);

    expect(cluster.writes).toEqual(["create"]);
    const spec = cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec;
    expect(spec?.nodeSelector).toBeUndefined();
    expect(spec?.tolerations).toBeUndefined();
  });

  test("a replica that cannot read the platform pod does not delete either", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    expect(cluster.has(DAEMONSET_NAME)).toBe(true);

    vi.mocked(OrganizationModel.getMcpIdleHibernationEnabled).mockResolvedValue(
      false,
    );
    await replicaPass(runtime, cluster, { platformPodUnreachable: true });

    // Removing the fleet's warm cache is a decision too, and it is not one to
    // take from a pass that could not read its own surroundings.
    expect(cluster.has(DAEMONSET_NAME)).toBe(true);
    expect(cluster.writes).toEqual(["create"]);
  });

  test("names the DaemonSet after the Helm release sharing the namespace", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    await prepuller(cluster).reconcileNow();

    expect([...cluster.daemonSets.keys()]).toEqual([DAEMONSET_NAME]);
  });

  test("a replica that cannot see a platform pod does not invent a second DaemonSet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // The orchestrator namespace is not always the release's, so this read
    // succeeds and answers "no platform pod here". Naming the DaemonSet after
    // a label on that pod therefore had no answer, and the fallback name was a
    // guess — one this replica then kept for life. Its peers, which could see
    // the pod, used the release's name, and the cluster ended up holding TWO
    // pre-pullers: two pull sequences on every node, and the guessed one named
    // after nothing, so no reconcile ever looked for it, no delete removed it,
    // and `helm uninstall` left it running.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    cluster.platformPodMissing = true;
    await prepuller(cluster).reconcileNow();

    cluster.platformPodMissing = false;
    await prepuller(cluster).reconcileNow();

    expect([...cluster.daemonSets.keys()]).toEqual([DAEMONSET_NAME]);
  });

  test("a replica whose first pass cannot read the cluster still uses the release's name", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // The blip that used to fork the fleet: one replica's first look at the
    // cluster fails, so it fell back to a conventional name and latched it for
    // the life of the process, while every healthy replica used the release's.
    // The cluster then held TWO pre-pull DaemonSets — the extra one named after
    // nothing, so no reconcile looked for it, no delete removed it, and
    // `helm uninstall` left it pulling every image on every node forever.
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    const unlucky = prepuller(cluster);
    cluster.platformPodReadsFail = true;
    await unlucky.reconcileNow();

    cluster.platformPodReadsFail = false;
    await unlucky.reconcileNow();
    await prepuller(cluster).reconcileNow();

    expect([...cluster.daemonSets.keys()]).toEqual([DAEMONSET_NAME]);
  });

  test("without a release name nothing is created at all", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    config.orchestrator.kubernetes.helmReleaseName = undefined;

    const runtime = prepuller(cluster);
    runtime.start();
    await runtime.reconcileNow();

    // A DaemonSet under a made-up name is worse than no DaemonSet: it is
    // invisible to every later reconcile and to `helm uninstall`.
    expect(cluster.daemonSets.size).toBe(0);
    expect(cluster.allCalls).toEqual([]);
    // And the operator is told once why, naming the variable that fixes it.
    const explanations = vi
      .mocked(logger.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((message) =>
        message.includes("ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME"),
      );
    expect(explanations).toHaveLength(1);
    runtime.stop();
  });

  test("hands the DaemonSet to the platform Deployment, so uninstalling takes it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    await prepuller(cluster).reconcileNow();

    // Helm cannot clean this up: the chart never templated it. An owner is how
    // the cluster's garbage collector does it instead.
    expect(cluster.ownersOf(DAEMONSET_NAME)).toEqual([
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: `${RELEASE}-archestra-platform`,
        uid: "platform-deployment-uid",
        controller: false,
        // Setting this needs `update` on the owner's finalizers subresource,
        // which the platform's Role does not grant — the API server would
        // reject the whole write.
        blockOwnerDeletion: false,
      },
    ]);
  });

  test("uses the Helm-owned same-namespace anchor when configured", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });
    config.orchestrator.kubernetes.runtimeOwnerConfigMapName = "helm-anchor";

    await prepuller(cluster).reconcileNow();

    expect(cluster.ownersOf(DAEMONSET_NAME)).toEqual([
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        name: "helm-anchor",
        uid: "helm-anchor-uid",
        controller: false,
        blockOwnerDeletion: false,
      },
    ]);
  });

  test("adopts a DaemonSet created while the owner could not be read", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await installLocalServer(makeInternalMcpCatalog, makeMcpServer, {
      dockerImage: "ghcr.io/acme/weather:1.4",
    });

    cluster.platformDeployment = undefined;
    const runtime = prepuller(cluster);
    await runtime.reconcileNow();
    // Un-owned, but caching: an owner is about cleanup, not about the cache.
    expect(cluster.ownersOf(DAEMONSET_NAME)).toEqual([]);

    cluster.platformDeployment = {
      name: `${RELEASE}-archestra-platform`,
      uid: "platform-deployment-uid",
    };
    await runtime.reconcileNow();

    // The spec never changed, so nothing else would have rewritten this object
    // — it would have stayed orphaned for as long as the release lived.
    expect(cluster.ownersOf(DAEMONSET_NAME)).toHaveLength(1);
  });
});

// === Fake cluster ===

/**
 * The DaemonSet as the API server would hold it, plus the reads the reconcile
 * makes about its own surroundings: the platform pod (whose scheduling
 * constraints the DaemonSet inherits), the platform Deployment (which owns it),
 * and the generated docker-registry Secrets.
 */
class FakeCluster {
  readonly daemonSets = new Map<string, k8s.V1DaemonSet>();
  readonly allCalls: string[] = [];
  readonly daemonSetCalls: string[] = [];
  readonly platformPodReadNamespaces: string[] = [];
  readonly writes: string[] = [];
  readonly secrets: k8s.V1Secret[] = [];

  forbidDaemonSets = false;
  failDaemonSetsWith: { statusCode: number; message: string } | null = null;
  /** Set while the replica taking its pass cannot reach the platform pod. */
  platformPodReadsFail = false;
  /**
   * Set while this namespace holds no platform pod at all — the orchestrator
   * namespace is not always the release's. The reads SUCCEED and the answer is
   * "there is none".
   */
  platformPodMissing = false;
  /**
   * Set while Secret reads answer 429 rather than 404 — the API server is
   * throttling us, which is emphatically NOT "the Secret is gone".
   */
  secretReadsThrottled = false;
  platformNodeSelector: Record<string, string> | undefined;
  platformTolerations: k8s.V1Toleration[] | undefined;
  deploymentImage: string | undefined;
  /**
   * The Deployment Helm created for this release. Absent models the platform
   * running in a different namespace from the MCP servers it schedules, where
   * there is no owner to point at.
   */
  platformDeployment: { name: string; uid: string } | undefined = {
    name: `${RELEASE}-archestra-platform`,
    uid: "platform-deployment-uid",
  };

  private resourceVersion = 1;

  reset(): void {
    this.allCalls.length = 0;
    this.daemonSetCalls.length = 0;
    this.writes.length = 0;
  }

  /** A Secret an operator created by hand, as `existing` entries name. */
  addSecret(name: string): void {
    this.secrets.push({ metadata: { name } } as k8s.V1Secret);
  }

  addRegcredSecret(name: string, mcpServerId: string): void {
    this.secrets.push({
      metadata: {
        name,
        labels: {
          app: "mcp-server",
          type: "regcred",
          "mcp-server-id": mcpServerId,
        },
      },
    } as k8s.V1Secret);
  }

  has(name: string): boolean {
    return this.daemonSets.has(name);
  }

  namespaceOf(name: string): string | undefined {
    return this.daemonSets.get(name)?.metadata?.namespace;
  }

  imagesOf(name: string): string[] {
    const initContainers =
      this.daemonSets.get(name)?.spec?.template.spec?.initContainers ?? [];
    // The first init container is the busybox bootstrap, not a cached image.
    return initContainers
      .slice(1)
      .map((container) => container.image as string);
  }

  ownersOf(name: string): k8s.V1OwnerReference[] {
    return this.daemonSets.get(name)?.metadata?.ownerReferences ?? [];
  }

  pullSecretsOf(name: string): k8s.V1LocalObjectReference[] {
    return (
      this.daemonSets.get(name)?.spec?.template.spec?.imagePullSecrets ?? []
    );
  }

  get coreApi(): k8s.CoreV1Api {
    return {
      readNamespacedPod: async () => {
        this.allCalls.push("readPod");
        if (this.platformPodReadsFail) throw CONNECTION_RESET;
        throw NOT_FOUND;
      },
      listNamespacedPod: async ({
        labelSelector,
        namespace,
      }: {
        labelSelector?: string;
        namespace: string;
      }) => {
        this.allCalls.push("listPods");
        this.platformPodReadNamespaces.push(namespace);
        if (this.platformPodReadsFail) throw CONNECTION_RESET;
        if (this.platformPodMissing) return { items: [] };
        if (labelSelector !== "app.kubernetes.io/name=archestra-platform") {
          return { items: [] };
        }
        return {
          items: [
            {
              metadata: {
                name: "archestra-platform-abc",
                labels: { "app.kubernetes.io/instance": RELEASE },
              },
              status: { phase: "Running" },
              spec: {
                containers: [],
                ...(this.platformNodeSelector
                  ? { nodeSelector: this.platformNodeSelector }
                  : {}),
                ...(this.platformTolerations
                  ? { tolerations: this.platformTolerations }
                  : {}),
              },
            } as k8s.V1Pod,
          ],
        };
      },
      listNamespacedSecret: async () => {
        this.allCalls.push("listSecrets");
        if (this.secretReadsThrottled) throw THROTTLED;
        return { items: this.secrets };
      },
      // Namespaced, like the real one: a Secret this namespace does not hold
      // is a 404 here however real it is somewhere else.
      readNamespacedSecret: async ({ name }: { name: string }) => {
        this.allCalls.push("readSecret");
        if (this.secretReadsThrottled) throw THROTTLED;
        const existing = this.secrets.find(
          (secret) => secret.metadata?.name === name,
        );
        if (!existing) throw NOT_FOUND;
        return structuredClone(existing);
      },
      readNamespacedConfigMap: async ({ name }: { name: string }) => {
        this.allCalls.push("readConfigMap");
        if (name !== "helm-anchor") throw NOT_FOUND;
        return {
          metadata: { name: "helm-anchor", uid: "helm-anchor-uid" },
        } as k8s.V1ConfigMap;
      },
    } as unknown as k8s.CoreV1Api;
  }

  get appsApi(): k8s.AppsV1Api {
    return {
      readNamespacedDeployment: async () => {
        this.allCalls.push("readDeployment");
        if (!this.deploymentImage) throw NOT_FOUND;
        return {
          spec: {
            template: {
              spec: {
                containers: [
                  { name: "mcp-server", image: this.deploymentImage },
                ],
              },
            },
          },
        } as k8s.V1Deployment;
      },
      listNamespacedDeployment: async ({
        labelSelector,
      }: {
        labelSelector?: string;
      }) => {
        this.allCalls.push("listDeployments");
        const owner = this.platformDeployment;
        if (
          !owner ||
          labelSelector !==
            `app.kubernetes.io/name=archestra-platform,app.kubernetes.io/instance=${RELEASE}`
        ) {
          return { items: [] };
        }
        return {
          items: [{ metadata: { name: owner.name, uid: owner.uid } }],
        };
      },
      readNamespacedDaemonSet: async ({ name }: { name: string }) => {
        this.note("read");
        const existing = this.daemonSets.get(name);
        if (!existing) throw NOT_FOUND;
        return structuredClone(existing);
      },
      createNamespacedDaemonSet: async ({
        body,
      }: {
        body: k8s.V1DaemonSet;
      }) => {
        this.note("create");
        this.writes.push("create");
        this.store(body);
        return structuredClone(body);
      },
      replaceNamespacedDaemonSet: async ({
        body,
      }: {
        body: k8s.V1DaemonSet;
      }) => {
        this.note("replace");
        this.writes.push("replace");
        this.store(body);
        return structuredClone(body);
      },
      deleteNamespacedDaemonSet: async ({ name }: { name: string }) => {
        this.note("delete");
        if (!this.daemonSets.has(name)) throw NOT_FOUND;
        this.writes.push("delete");
        this.daemonSets.delete(name);
        return {};
      },
    } as unknown as k8s.AppsV1Api;
  }

  private note(call: string): void {
    this.allCalls.push(call);
    this.daemonSetCalls.push(call);
    if (this.forbidDaemonSets) throw FORBIDDEN;
    if (this.failDaemonSetsWith) throw this.failDaemonSetsWith;
  }

  private store(body: k8s.V1DaemonSet): void {
    const stored = structuredClone(body);
    stored.metadata = {
      ...stored.metadata,
      resourceVersion: String(++this.resourceVersion),
    };
    this.daemonSets.set(stored.metadata.name as string, stored);
  }
}

function prepuller(
  cluster: FakeCluster,
  platformNamespace = NAMESPACE,
): McpImagePrepuller {
  return new McpImagePrepuller({
    coreApi: cluster.coreApi,
    appsApi: cluster.appsApi,
    namespace: NAMESPACE,
    platformNamespace,
  });
}

/**
 * One replica's reconcile, optionally with that replica's read of the platform
 * pod failing — the transient error one replica hits and another does not.
 *
 * The platform pod spec `k8s-deployment` caches is process-wide state, so two
 * `McpImagePrepuller`s in one test would otherwise share whichever replica
 * looked first; dropping it between passes is what makes each pass stand for a
 * separate replica process, which is what the chart actually runs.
 */
async function replicaPass(
  runtime: McpImagePrepuller,
  cluster: FakeCluster,
  options: {
    platformPodUnreachable?: boolean;
    secretReadsThrottled?: boolean;
  } = {},
): Promise<void> {
  resetPlatformNodeSelectorCache();
  resetPlatformTolerationsCache();
  cluster.platformPodReadsFail = options.platformPodUnreachable === true;
  cluster.secretReadsThrottled = options.secretReadsThrottled === true;
  try {
    await runtime.reconcileNow();
  } finally {
    cluster.platformPodReadsFail = false;
    cluster.secretReadsThrottled = false;
  }
}

type LocalConfig = z.infer<typeof LocalConfigSchema>;

/** A local install whose catalog carries the given deployment configuration. */
async function installLocalServer(
  makeInternalMcpCatalog: (overrides: {
    serverType: "local";
    localConfig: LocalConfig;
  }) => Promise<{ id: string }>,
  makeMcpServer: (overrides: { catalogId: string }) => Promise<{ id: string }>,
  localConfig: LocalConfig,
): Promise<{ id: string }> {
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig,
  });
  return makeMcpServer({ catalogId: catalog.id });
}

/** The payloads of the warnings that named un-cacheable images. */
function prepullSkips(warn: {
  mock: { calls: unknown[][] };
}): Array<{ namespace?: string; skipped?: Array<Record<string, unknown>> }> {
  return warn.mock.calls
    .filter((call) => String(call[1]).includes("pre-pulling skipped"))
    .map((call) => call[0] as { skipped?: Array<Record<string, unknown>> });
}

/** The warnings that reported pre-pulling paused on an unreadable pod. */
function pausedWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((call) => String(call[1]))
    .filter((message) => message.includes("pre-pulling is paused"));
}

/** The warnings that named the missing DaemonSet rule, as rendered messages. */
function rbacDenials(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((call) => String(call[1]))
    .filter((message) => message.includes("daemonsets"));
}

function hashOf(daemonSet: k8s.V1DaemonSet): string | undefined {
  return daemonSet.metadata?.annotations?.["archestra.io/prepull-spec-hash"];
}

/** The refresh-generations annotation of the LIVE DaemonSet, raw. */
function generationsOf(cluster: FakeCluster): string | undefined {
  return cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.metadata
    ?.annotations?.["archestra.io/prepull-refresh-generations"];
}

function pullPolicyOf(cluster: FakeCluster, image: string): string | undefined {
  return (
    cluster.daemonSets.get(DAEMONSET_NAME)?.spec?.template.spec
      ?.initContainers ?? []
  ).find((container) => container.image === image)?.imagePullPolicy;
}
