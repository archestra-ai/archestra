import type * as k8s from "@kubernetes/client-node";
import { PatchStrategy } from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/k8s/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/shared")>()),
  isK8sConfigured: vi.fn(),
  getK8sNamespace: vi.fn(),
  loadKubeConfig: vi.fn(),
  createK8sClients: vi.fn(),
}));

vi.mock("@/k8s/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/capabilities")>()),
  getK8sCapabilities: vi.fn(),
}));

vi.mock("@/k8s/cluster-dns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/cluster-dns")>()),
  clusterDnsResolver: { getClusterDnsIps: vi.fn() },
}));

// reconcileEnvironment short-circuits unless the sandbox feature is on; flip the
// flag, leaving the rest of config real so the StatefulSet builder tests stand.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    skillsSandbox: { enabled: true },
  }),
);

// Mock the leaf module (not the @/models barrel) so the override propagates
// through the index's `export { default as OrganizationModel }` re-export to the
// manager's own import — mocking the barrel does not. resolveEffectiveNetworkPolicy
// is left real: it's a pure resolver, so asserting its result proves the wiring.
vi.mock("@/models/organization", () => ({
  default: {
    getDefaultEngineTarget: vi.fn(),
    getDefaultNetworkPolicy: vi.fn(),
    listDefaultEngineTargets: vi.fn(),
  },
}));

import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  loadKubeConfig,
} from "@/k8s/shared";
import OrganizationModel from "@/models/organization";
import type { Environment, Organization } from "@/types";
import { isUuid } from "@/utils/uuid";
import { daggerEnvironmentRuntimeManager } from "./manager";

const mockIsK8sConfigured = vi.mocked(isK8sConfigured);
const mockGetK8sNamespace = vi.mocked(getK8sNamespace);
const mockLoadKubeConfig = vi.mocked(loadKubeConfig);
const mockCreateK8sClients = vi.mocked(createK8sClients);
const mockGetK8sCapabilities = vi.mocked(getK8sCapabilities);
const mockGetClusterDnsIps = vi.mocked(clusterDnsResolver.getClusterDnsIps);

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "abcdef00-1111-2222-3333-444455556666",
    organizationId: "org-1",
    namespace: null,
    networkPolicy: null,
    ...overrides,
  } as unknown as Environment;
}

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "default-org",
    defaultEnvironmentNamespace: null,
    defaultNetworkPolicy: null,
    ...overrides,
  } as unknown as Organization;
}

describe("environmentTargetForEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetK8sNamespace.mockReturnValue("archestra-release");
  });

  it("returns undefined when Kubernetes is not configured", () => {
    mockIsK8sConfigured.mockReturnValue(false);
    expect(
      daggerEnvironmentRuntimeManager.environmentTargetForEnvironment(
        makeEnv(),
      ),
    ).toBeUndefined();
  });

  it("returns the environment id + its explicit namespace", () => {
    mockIsK8sConfigured.mockReturnValue(true);
    const env = makeEnv({ namespace: "ns-production" });
    expect(
      daggerEnvironmentRuntimeManager.environmentTargetForEnvironment(env),
    ).toEqual({
      environmentId: "abcdef00-1111-2222-3333-444455556666",
      namespace: "ns-production",
    });
  });

  it("falls back to the release namespace when the environment has no namespace", () => {
    mockIsK8sConfigured.mockReturnValue(true);
    expect(
      daggerEnvironmentRuntimeManager.environmentTargetForEnvironment(
        makeEnv({ namespace: null }),
      ),
    ).toEqual({
      environmentId: "abcdef00-1111-2222-3333-444455556666",
      namespace: "archestra-release",
    });
  });

  it("treats a blank namespace as no namespace", () => {
    mockIsK8sConfigured.mockReturnValue(true);
    expect(
      daggerEnvironmentRuntimeManager.environmentTargetForEnvironment(
        makeEnv({ namespace: "   " }),
      )?.namespace,
    ).toBe("archestra-release");
  });
});

describe("organizationDefaultTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetK8sNamespace.mockReturnValue("archestra-release");
    mockIsK8sConfigured.mockReturnValue(true);
  });

  it("returns undefined when Kubernetes is not configured", () => {
    mockIsK8sConfigured.mockReturnValue(false);
    expect(
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(makeOrg()),
    ).toBeUndefined();
  });

  it("derives a canonical UUID engine id from the non-UUID org id", () => {
    const target = daggerEnvironmentRuntimeManager.organizationDefaultTarget(
      makeOrg(),
    );
    expect(target?.environmentId).toBeDefined();
    // The org id ("default-org") is not a UUID, but the engine id must be one so
    // the kube-pod:// address passes its NAPI UUID validation.
    expect(isUuid(target?.environmentId ?? "")).toBe(true);
  });

  it("derives the same id for the same org and different ids for different orgs", () => {
    const a1 = daggerEnvironmentRuntimeManager.organizationDefaultTarget(
      makeOrg({ id: "org-a" }),
    )?.environmentId;
    const a2 = daggerEnvironmentRuntimeManager.organizationDefaultTarget(
      makeOrg({ id: "org-a" }),
    )?.environmentId;
    const b = daggerEnvironmentRuntimeManager.organizationDefaultTarget(
      makeOrg({ id: "org-b" }),
    )?.environmentId;
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  // Golden vector. The engine id is a UUIDv5 of the org id under a fixed
  // namespace constant, and it is the pod's identity: change that constant and
  // every organization silently re-keys to a new engine, orphaning the running
  // StatefulSet and stranding its Retain-policy PVC. Determinism within a run
  // cannot catch that — only a pinned value across releases can. Cross-checked
  // against an independent uuid5 implementation.
  it.each([
    ["org-golden-1", "057d66d6-e4d6-5e5b-9072-ed0f1b5c78c2"],
    ["org-abc", "76c4c009-e725-55ad-94ac-248c98da59d5"],
  ])("derives a stable engine id for %s across releases", (id, expected) => {
    expect(
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(makeOrg({ id }))
        ?.environmentId,
    ).toBe(expected);
  });

  it("uses the org's default namespace, else the release namespace", () => {
    expect(
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(
        makeOrg({ defaultEnvironmentNamespace: "ns-team" }),
      )?.namespace,
    ).toBe("ns-team");
    expect(
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(
        makeOrg({ defaultEnvironmentNamespace: null }),
      )?.namespace,
    ).toBe("archestra-release");
  });

  // Rows written before the namespace was validated can hold anything. Such a
  // value would fail the Kubernetes create and be rejected by the kube-pod://
  // target's UUID/RFC1123 validation, wedging every sandbox run for that org.
  it.each([
    ["Team-A", "uppercase"],
    ["a.b.example.com", "dots"],
    ["x".repeat(64), "over 63 characters"],
    ["-leading-hyphen", "leading hyphen"],
    ["under_score", "underscore"],
  ])("falls back to the release namespace for a stored %s namespace (%s)", (namespace) => {
    expect(
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(
        makeOrg({ defaultEnvironmentNamespace: namespace }),
      )?.namespace,
    ).toBe("archestra-release");
  });
});

describe("buildEngineStatefulSet", () => {
  const ENGINE_ID = "abcdef00-1111-2222-3333-444455556666";
  function build(): k8s.V1StatefulSet {
    return (
      daggerEnvironmentRuntimeManager as unknown as {
        buildEngineStatefulSet(engineId: string, ns: string): k8s.V1StatefulSet;
      }
    ).buildEngineStatefulSet(ENGINE_ID, "ns-x");
  }

  it("sources engine resources from config so small clusters can override them", () => {
    const engine = config.daggerRuntime.engine;
    const original = { ...engine };
    // Every value differs from the shipped default, so hardcoding a default in
    // buildEngineStatefulSet fails here instead of passing by coincidence.
    Object.assign(engine, {
      cpuRequest: "500m",
      memoryRequest: "512Mi",
      memoryLimit: "1Gi",
      cacheStorage: "10Gi",
    });
    try {
      const sts = build();
      const container = sts.spec?.template.spec?.containers[0];
      expect(container?.resources?.requests?.cpu).toBe("500m");
      expect(container?.resources?.requests?.memory).toBe("512Mi");
      expect(container?.resources?.limits?.memory).toBe("1Gi");
      expect(
        sts.spec?.volumeClaimTemplates?.[0].spec?.resources?.requests?.storage,
      ).toBe("10Gi");
    } finally {
      Object.assign(engine, original);
    }
  });

  it("persists /var/lib/dagger on a per-replica PVC, not an emptyDir", () => {
    const sts = build();
    const vct = sts.spec?.volumeClaimTemplates ?? [];
    expect(vct).toHaveLength(1);
    expect(vct[0].metadata?.name).toBe("varlib");
    expect(vct[0].spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(vct[0].spec?.resources?.requests?.storage).toBe("50Gi");
    // The cache PVC must survive engine deletion/scale-down so a teardown
    // doesn't discard the warm buildkit cache.
    expect(sts.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });

    const podSpec = sts.spec?.template.spec;
    expect(
      podSpec?.containers[0].volumeMounts?.find(
        (m) => m.mountPath === "/var/lib/dagger",
      )?.name,
    ).toBe("varlib");
    // the cache must NOT be shadowed by an ephemeral emptyDir of the same name;
    // only the runtime socket dir stays emptyDir.
    expect(podSpec?.volumes?.find((v) => v.name === "varlib")).toBeUndefined();
    expect(
      podSpec?.volumes?.find((v) => v.name === "run")?.emptyDir,
    ).toBeDefined();
  });

  it("runs a single privileged engine replica with a stable name", () => {
    const sts = build();
    expect(sts.spec?.replicas).toBe(1);
    expect(sts.metadata?.name).toBe(
      "dagger-engine-abcdef00-1111-2222-3333-444455556666",
    );
    const container = sts.spec?.template.spec?.containers[0];
    expect(container?.image).toBe("registry.dagger.io/engine:v0.21.5");
    expect(container?.securityContext?.privileged).toBe(true);
  });

  it("hardens the privileged engine: no SA token, memory cap, engine config mounted", () => {
    const sts = build();
    const podSpec = sts.spec?.template.spec;
    // A privileged pod must not carry a usable API token next to sandbox code.
    expect(podSpec?.automountServiceAccountToken).toBe(false);

    const container = podSpec?.containers[0];
    // Resources mirror the dagger-runtime chart engine.
    expect(container?.resources?.requests?.cpu).toBe("2");
    expect(container?.resources?.requests?.memory).toBe("4Gi");
    expect(container?.resources?.limits?.memory).toBe("4Gi");

    // engine.json is mounted from the per-env ConfigMap (disables insecure root
    // capabilities + bounds the buildkit GC).
    expect(
      container?.volumeMounts?.find(
        (m) => m.mountPath === "/etc/dagger/engine.json",
      )?.subPath,
    ).toBe("engine.json");
    expect(
      podSpec?.volumes?.find((v) => v.name === "config")?.configMap?.name,
    ).toBe("dagger-engine-abcdef00-1111-2222-3333-444455556666-config");
  });

  it("caps sandbox memory in a per-engine cgroup and keeps the image entrypoint", () => {
    const engine = config.daggerRuntime.engine;
    const original = { ...engine };
    Object.assign(engine, { sandboxMemoryMaxBytes: 1234567 });
    try {
      const script = build().spec?.template.spec?.containers[0].command?.[2];
      const cgroup = "archestra-sandbox-abcdef00-1111-2222-3333-444455556666";
      // The configured ceiling reaches the cgroup verbatim; a stale or rounded
      // value would silently leave sandboxes bounded at the wrong number.
      expect(script).toContain(
        `echo 1234567 > /sys/fs/cgroup/${cgroup}/memory.max`,
      );
      // Named per engine, not shared: a privileged pod sees the host's cgroup
      // tree, so engines on one node would otherwise share a single budget.
      expect(script).toContain(`defaultCgroupParent = "/${cgroup}"`);
      // Buildkit only puts sandboxes there if pointed at it, and only reads
      // that from the legacy config file.
      expect(script).toContain("> /etc/dagger/engine.toml");
      // The image entrypoint has to be what ends up running: it delegates the
      // cgroup controllers this cap depends on and raises the open-file limit.
      expect(script).toContain("exec /usr/local/bin/dagger-entrypoint.sh");
      // A cluster that never delegates the memory controller must end up with
      // an unbounded engine rather than a crash-looping one, since engine
      // StatefulSets are created once and never reconciled afterwards.
      expect(script).toContain("archestra: sandbox memory is NOT capped");
    } finally {
      Object.assign(engine, original);
    }
  });
});

describe("resolveEngineEffectivePolicy", () => {
  function resolve(target: {
    engineId: string;
    organizationId: string;
    networkPolicyOverride: unknown;
  }) {
    return (
      daggerEnvironmentRuntimeManager as unknown as {
        resolveEngineEffectivePolicy(
          t: unknown,
        ): Promise<{ source: string; policy: unknown }>;
      }
    ).resolveEngineEffectivePolicy(target);
  }

  it("inherits the restricted org default when the target carries no override", async () => {
    // Without threading the org default, a target with no override resolves to
    // the unrestricted built-in (source "built_in") and the engine egresses
    // freely. Asserting the real resolver returns the org default proves the wire.
    // This is the org-default engine's path (it always carries a null override).
    const defaultNetworkPolicy = { egressMode: "restricted" };
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
      defaultNetworkPolicy as never,
    );

    const result = await resolve({
      engineId: "abcdef00-1111-2222-3333-444455556666",
      organizationId: "org-1",
      networkPolicyOverride: null,
    });

    expect(result).toEqual({
      source: "organization_default",
      policy: defaultNetworkPolicy,
    });
  });

  it("uses the target's own override policy over the org default", async () => {
    const ownPolicy = { egressMode: "restricted", allowedDomains: ["a.test"] };
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue({
      egressMode: "off",
    } as never);

    const result = await resolve({
      engineId: "abcdef00-1111-2222-3333-444455556666",
      organizationId: "org-1",
      networkPolicyOverride: ownPolicy,
    });

    expect(result).toEqual({ source: "environment", policy: ownPolicy });
  });
});

describe("reconcileEnvironment — applyCustomPolicy upsert (AWS ApplicationNetworkPolicy)", () => {
  const ANP_COORDS = {
    group: "networking.k8s.aws",
    version: "v1alpha1",
    plural: "applicationnetworkpolicies",
  };
  // AWS provider + restricted egress with ≥1 domain routes
  // buildDaggerEgressPolicies to an ApplicationNetworkPolicy custom object.
  const awsCapabilities = {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: false,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: true,
    provider: "aws-application-network-policy",
    supportsFqdn: true,
    supportsHttpMethods: false,
    message: null,
  };
  const restrictedPolicy = {
    egressMode: "restricted",
    domainPreset: "none",
    allowedDomains: ["registry.npmjs.org"],
    allowedCidrs: [],
  };

  function makeFakeClients() {
    return {
      namespace: "test-ns",
      coreApi: {
        createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
        replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
      },
      appsApi: {
        createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
      },
      networkingApi: {
        deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      },
      customObjectsApi: {
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      },
    };
  }

  let clients: ReturnType<typeof makeFakeClients>;

  beforeEach(() => {
    vi.clearAllMocks();
    clients = makeFakeClients();
    mockIsK8sConfigured.mockReturnValue(true);
    mockGetK8sNamespace.mockReturnValue("test-ns");
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
      null,
    );
    mockGetK8sCapabilities.mockResolvedValue({
      networkPolicy: awsCapabilities,
    } as never);
    mockGetClusterDnsIps.mockResolvedValue(["10.0.0.10"]);
    mockLoadKubeConfig.mockReturnValue({ kubeConfig: {} } as never);
    mockCreateK8sClients.mockReturnValue(clients as never);
  });

  function reconcile() {
    return daggerEnvironmentRuntimeManager.reconcileEnvironment(
      makeEnv({
        namespace: "test-ns",
        networkPolicy: restrictedPolicy as never,
      }),
    );
  }

  it("creates the policy and does not patch or replace when it doesn't exist yet", async () => {
    await reconcile();

    expect(
      clients.customObjectsApi.createNamespacedCustomObject,
    ).toHaveBeenCalledTimes(1);
    expect(
      clients.customObjectsApi.createNamespacedCustomObject,
    ).toHaveBeenCalledWith(expect.objectContaining(ANP_COORDS));
    expect(
      clients.customObjectsApi.patchNamespacedCustomObject,
    ).not.toHaveBeenCalled();
    expect(
      clients.customObjectsApi.replaceNamespacedCustomObject,
    ).not.toHaveBeenCalled();
  });

  it("merge-patches (not PUT-replaces) when the policy already exists (409)", async () => {
    clients.customObjectsApi.createNamespacedCustomObject.mockRejectedValueOnce(
      {
        statusCode: 409,
      },
    );

    await reconcile();

    const createBody = clients.customObjectsApi.createNamespacedCustomObject
      .mock.calls[0][0].body as { metadata: { name: string } };
    const patchCalls =
      clients.customObjectsApi.patchNamespacedCustomObject.mock.calls;
    expect(patchCalls).toHaveLength(1);
    const [patchArgs, headerOptions] = patchCalls[0];
    expect(patchArgs).toEqual({
      ...ANP_COORDS,
      namespace: "test-ns",
      name: createBody.metadata.name,
      body: createBody,
    });
    // setHeaderOptions wraps the Content-Type in a `pre` middleware closure, so
    // the options object can't be compared by value; run the middleware against
    // a fake request to assert it sets the JSON merge-patch content type.
    const fakeRequest = { setHeaderParam: vi.fn() };
    (
      headerOptions as { middleware: { pre: (r: unknown) => unknown }[] }
    ).middleware[0].pre(fakeRequest);
    expect(fakeRequest.setHeaderParam).toHaveBeenCalledWith(
      "Content-Type",
      PatchStrategy.MergePatch,
    );
    expect(
      clients.customObjectsApi.replaceNamespacedCustomObject,
    ).not.toHaveBeenCalled();
  });

  it("propagates a non-conflict create error without patching or replacing", async () => {
    clients.customObjectsApi.createNamespacedCustomObject.mockRejectedValueOnce(
      {
        statusCode: 500,
      },
    );

    await expect(reconcile()).rejects.toMatchObject({ statusCode: 500 });

    expect(
      clients.customObjectsApi.patchNamespacedCustomObject,
    ).not.toHaveBeenCalled();
    expect(
      clients.customObjectsApi.replaceNamespacedCustomObject,
    ).not.toHaveBeenCalled();
  });
});

describe("reconcileOrganizationDefault", () => {
  const k8sCapabilities = {
    kubernetesNetworkPolicy: true,
    ciliumNetworkPolicy: false,
    gkeFqdnNetworkPolicy: false,
    awsApplicationNetworkPolicy: false,
    provider: "kubernetes-network-policy",
    supportsFqdn: false,
    supportsHttpMethods: false,
    message: null,
  };

  function makeFakeClients() {
    return {
      namespace: "test-ns",
      coreApi: {
        createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
        replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
        deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
        deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
      },
      appsApi: {
        createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
        deleteNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
      },
      networkingApi: {
        createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
        replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
        deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      },
      customObjectsApi: {
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      },
    };
  }

  let clients: ReturnType<typeof makeFakeClients>;

  beforeEach(() => {
    vi.clearAllMocks();
    clients = makeFakeClients();
    mockIsK8sConfigured.mockReturnValue(true);
    mockGetK8sNamespace.mockReturnValue("release-ns");
    mockGetK8sCapabilities.mockResolvedValue({
      networkPolicy: k8sCapabilities,
    } as never);
    mockGetClusterDnsIps.mockResolvedValue(["10.0.0.10"]);
    mockLoadKubeConfig.mockReturnValue({ kubeConfig: {} } as never);
    mockCreateK8sClients.mockReturnValue(clients as never);
  });

  // isEnabled() gates on both the sandbox flag and Kubernetes being configured.
  // A disabled runtime that still reconciled would create a privileged engine
  // pod on a deployment that never opted into running untrusted code.
  it.each([
    ["the sandbox flag is off", { sandbox: false, k8s: true }],
    ["Kubernetes is not configured", { sandbox: true, k8s: false }],
  ])("provisions nothing when %s", async (_label, { sandbox, k8s }) => {
    const originalEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = sandbox;
    mockIsK8sConfigured.mockReturnValue(k8s);
    try {
      // Both entry points must stay inert: an environment engine is as
      // privileged as the org-default one.
      await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(
        makeOrg({ id: "org-off" }),
      );
      await daggerEnvironmentRuntimeManager.reconcileEnvironment(
        makeEnv({ namespace: "release-ns" }),
      );
      expect(
        clients.appsApi.createNamespacedStatefulSet,
      ).not.toHaveBeenCalled();
      expect(clients.coreApi.createNamespacedConfigMap).not.toHaveBeenCalled();
      expect(
        clients.networkingApi.createNamespacedNetworkPolicy,
      ).not.toHaveBeenCalled();
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
    }
  });

  // A bring-your-own runner host serves every unbound run, so an org-default
  // engine would be a privileged pod nothing routes to. Per-environment engines
  // must keep being provisioned: bound agents run on their own engine so the
  // environment's egress policy still applies.
  it("provisions no org-default engine when a BYO runner host is set, but still provisions per-environment engines", async () => {
    const original = config.daggerRuntime.runnerHost;
    (config.daggerRuntime as { runnerHost?: string }).runnerHost =
      "tcp://byo:1234";
    try {
      const org = makeOrg({ id: "org-byo" });
      vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
        org.defaultNetworkPolicy as never,
      );

      await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(org);
      expect(
        clients.appsApi.createNamespacedStatefulSet,
      ).not.toHaveBeenCalled();
      expect(clients.coreApi.createNamespacedConfigMap).not.toHaveBeenCalled();

      await daggerEnvironmentRuntimeManager.reconcileEnvironment(
        makeEnv({ namespace: "release-ns" }),
      );
      expect(clients.appsApi.createNamespacedStatefulSet).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      (config.daggerRuntime as { runnerHost?: string }).runnerHost = original;
    }
  });

  // Routing and provisioning must never disagree about where the engine lives:
  // both resolve the namespace through engineNamespace(), so an invalid stored
  // value sends the StatefulSet and the kube-pod:// target to the same fallback.
  it("provisions into the release namespace when the stored namespace is invalid, matching the routing target", async () => {
    const org = makeOrg({
      id: "org-bad",
      defaultEnvironmentNamespace: "Team-A",
    });
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
      org.defaultNetworkPolicy as never,
    );
    const target =
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(org);

    await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(org);

    expect(target?.namespace).toBe("release-ns");
    expect(
      clients.appsApi.createNamespacedStatefulSet.mock.calls[0][0].namespace,
    ).toBe("release-ns");
    expect(
      clients.coreApi.createNamespacedConfigMap.mock.calls[0][0].namespace,
    ).toBe("release-ns");
  });

  it("provisions the derived engine + config in the org's namespace, applies the unrestricted floor when the org sets no policy", async () => {
    const org = makeOrg({
      id: "org-x",
      defaultEnvironmentNamespace: "team-ns",
      defaultNetworkPolicy: null,
    });
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
      org.defaultNetworkPolicy as never,
    );
    const engineId =
      daggerEnvironmentRuntimeManager.organizationDefaultTarget(
        org,
      )?.environmentId;

    await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(org);

    expect(clients.coreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1);
    const stsCall =
      clients.appsApi.createNamespacedStatefulSet.mock.calls[0][0];
    expect(stsCall.namespace).toBe("team-ns");
    expect(stsCall.body.metadata.name).toBe(`dagger-engine-${engineId}`);
    // With no org policy the engine still gets the unrestricted-egress floor every
    // per-env engine gets: public internet allowed, private/link-local/metadata
    // ranges blocked (the 0.0.0.0/0 rule carries an `except` list, not allow-all).
    const npBody =
      clients.networkingApi.createNamespacedNetworkPolicy.mock.calls[0][0].body;
    const publicRule = npBody.spec.egress.find(
      (r: { to?: { ipBlock?: { cidr: string } }[] }) =>
        r.to?.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(publicRule.to[0].ipBlock.except.length).toBeGreaterThan(0);
  });

  it("applies the org default egress policy to the default engine", async () => {
    const org = makeOrg({
      id: "org-y",
      defaultNetworkPolicy: {
        egressMode: "restricted",
        domainPreset: "none",
        allowedDomains: ["registry.npmjs.org"],
        allowedCidrs: [],
      },
    });
    vi.mocked(OrganizationModel.getDefaultNetworkPolicy).mockResolvedValue(
      org.defaultNetworkPolicy as never,
    );

    await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(org);

    expect(
      clients.networkingApi.createNamespacedNetworkPolicy,
    ).toHaveBeenCalledTimes(1);
    // Assert the org's OWN restricted policy was applied, not the unrestricted
    // floor a null policy produces: the floor allows all public egress via a
    // 0.0.0.0/0-with-except rule, so a genuinely restricted policy must NOT carry
    // one — and must still have egress rules (it isn't a no-op).
    const npBody =
      clients.networkingApi.createNamespacedNetworkPolicy.mock.calls[0][0].body;
    expect(npBody.spec.egress.length).toBeGreaterThan(0);
    const hasPublicAllow = npBody.spec.egress.some(
      (r: { to?: { ipBlock?: { cidr: string } }[] }) =>
        r.to?.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(hasPublicAllow).toBe(false);
  });

  it("tears down the old namespace's engine (StatefulSet, PVC, ConfigMap, policy) when the default namespace changes", async () => {
    const org = makeOrg({ id: "org-x", defaultEnvironmentNamespace: "new-ns" });

    await daggerEnvironmentRuntimeManager.teardownOrganizationDefaultEngine(
      org,
      "old-ns",
    );

    // Everything is deleted in the OLD namespace it moved away from.
    expect(mockCreateK8sClients).toHaveBeenCalledWith(
      expect.anything(),
      "old-ns",
    );
    expect(clients.appsApi.deleteNamespacedStatefulSet).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "old-ns" }),
    );
    // The Retain-policy cache PVC is `varlib-<statefulset>-0`; deleting the
    // StatefulSet alone would strand it.
    const pvcCall =
      clients.coreApi.deleteNamespacedPersistentVolumeClaim.mock.calls[0][0];
    expect(pvcCall.namespace).toBe("old-ns");
    expect(pvcCall.name).toMatch(/^varlib-.*-0$/);
    expect(clients.coreApi.deleteNamespacedConfigMap).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "old-ns" }),
    );
    expect(
      clients.networkingApi.deleteNamespacedNetworkPolicy,
    ).toHaveBeenCalledWith(expect.objectContaining({ namespace: "old-ns" }));
  });

  it("does not tear down when the namespace resolves to the same place (would delete the live engine)", async () => {
    // Both the previous and current values are invalid, so both fall back to the
    // release namespace — the engine never moved.
    const org = makeOrg({ id: "org-x", defaultEnvironmentNamespace: "Bad_NS" });

    await daggerEnvironmentRuntimeManager.teardownOrganizationDefaultEngine(
      org,
      "Also_Bad",
    );

    expect(clients.appsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled();
    expect(
      clients.coreApi.deleteNamespacedPersistentVolumeClaim,
    ).not.toHaveBeenCalled();
  });

  it("tears down nothing behind a BYO runner host (no org-default engine exists)", async () => {
    const original = config.daggerRuntime.runnerHost;
    (config.daggerRuntime as { runnerHost?: string }).runnerHost =
      "tcp://byo:1234";
    try {
      await daggerEnvironmentRuntimeManager.teardownOrganizationDefaultEngine(
        makeOrg({ id: "org-x", defaultEnvironmentNamespace: "new-ns" }),
        "old-ns",
      );
      expect(
        clients.appsApi.deleteNamespacedStatefulSet,
      ).not.toHaveBeenCalled();
    } finally {
      (config.daggerRuntime as { runnerHost?: string }).runnerHost = original;
    }
  });
});
