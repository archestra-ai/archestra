import type * as k8s from "@kubernetes/client-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/k8s/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/shared")>()),
  isK8sConfigured: vi.fn(),
  getK8sNamespace: vi.fn(),
}));

// Mock the leaf module (not the @/models barrel) so the override propagates
// through the index's `export { default as OrganizationModel }` re-export to the
// manager's own import — mocking the barrel does not. resolveEffectiveNetworkPolicy
// is left real: it's a pure resolver, so asserting its result proves the wiring.
vi.mock("@/models/organization", () => ({
  default: { getById: vi.fn() },
}));

import { getK8sNamespace, isK8sConfigured } from "@/k8s/shared";
import OrganizationModel from "@/models/organization";
import type { Environment } from "@/types";
import { daggerEnvironmentRuntimeManager } from "./manager";

const mockIsK8sConfigured = vi.mocked(isK8sConfigured);
const mockGetK8sNamespace = vi.mocked(getK8sNamespace);

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
    expect(container?.image).toBe("registry.dagger.io/engine:v0.21.0");
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
