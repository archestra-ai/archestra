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
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      skillsSandbox: { ...actual.default.skillsSandbox, enabled: true },
    },
  };
});

// Mock the leaf module (not the @/models barrel) so the override propagates
// through the index's `export { default as OrganizationModel }` re-export to the
// manager's own import — mocking the barrel does not. resolveEffectiveNetworkPolicy
// is left real: it's a pure resolver, so asserting its result proves the wiring.
vi.mock("@/models/organization", () => ({
  default: { getById: vi.fn() },
}));

import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  loadKubeConfig,
} from "@/k8s/shared";
import OrganizationModel from "@/models/organization";
import type { Environment } from "@/types";
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

describe("buildEngineStatefulSet", () => {
  function build(): k8s.V1StatefulSet {
    return (
      daggerEnvironmentRuntimeManager as unknown as {
        buildEngineStatefulSet(e: Environment, ns: string): k8s.V1StatefulSet;
      }
    ).buildEngineStatefulSet(makeEnv({ namespace: "ns-x" }), "ns-x");
  }

  it("persists /var/lib/dagger on a per-replica PVC, not an emptyDir", () => {
    const sts = build();
    const vct = sts.spec?.volumeClaimTemplates ?? [];
    expect(vct).toHaveLength(1);
    expect(vct[0].metadata?.name).toBe("varlib");
    expect(vct[0].spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(vct[0].spec?.resources?.requests?.storage).toBe("50Gi");

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
    expect(container?.resources?.requests?.memory).toBe("8Gi");
    expect(container?.resources?.limits?.memory).toBe("16Gi");

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
});

describe("resolveEngineEffectivePolicy", () => {
  function resolve(env: Environment) {
    return (
      daggerEnvironmentRuntimeManager as unknown as {
        resolveEngineEffectivePolicy(
          e: Environment,
        ): Promise<{ source: string; policy: unknown }>;
      }
    ).resolveEngineEffectivePolicy(env);
  }

  it("inherits the restricted org default when the env has no own policy", async () => {
    // Without threading the org default, an env with no own policy resolves to
    // the unrestricted built-in (source "built_in") and the engine egresses
    // freely. Asserting the real resolver returns the org default proves the wire.
    const defaultNetworkPolicy = { egressMode: "restricted" };
    vi.mocked(OrganizationModel.getById).mockResolvedValue({
      defaultNetworkPolicy,
    } as never);

    const result = await resolve(makeEnv({ networkPolicy: null }));

    expect(result).toEqual({
      source: "organization_default",
      policy: defaultNetworkPolicy,
    });
  });

  it("uses the env's own policy over the org default", async () => {
    const ownPolicy = { egressMode: "restricted", allowedDomains: ["a.test"] };
    vi.mocked(OrganizationModel.getById).mockResolvedValue({
      defaultNetworkPolicy: { egressMode: "off" },
    } as never);

    const result = await resolve(
      makeEnv({ networkPolicy: ownPolicy as never }),
    );

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
    vi.mocked(OrganizationModel.getById).mockResolvedValue(null as never);
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
