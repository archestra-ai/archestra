import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearK8sCapabilitiesCache,
  getK8sCapabilitiesFromApi,
} from "./capabilities";

describe("Kubernetes capability inspection", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearK8sCapabilitiesCache();
  });

  test("reports Cilium FQDN support when the CiliumNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "cilium.io" ? [{ name: "ciliumnetworkpolicies" }] : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledWith({
      group: "cilium.io",
      version: "v2",
    });
    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: true,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "cilium",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("reports enforcement unavailable when no provider CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn().mockRejectedValue({ statusCode: 404 }),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: false,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "none",
      supportsFqdn: false,
      supportsHttpMethods: false,
    });
  });

  test("reports enforcement unavailable when only stock GKE CRDs exist (NetworkPolicy addon off)", async () => {
    // A GKE cluster with the NetworkPolicy addon off (LEGACY datapath, only
    // `netd` running): the Calico, Cilium, and AWS groups are absent, and
    // networking.gke.io resolves to stock CRDs with no fqdnnetworkpolicies. The
    // capability must report no enforcer.
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => {
        if (group === "networking.gke.io") {
          return {
            resources: [
              { name: "frontendconfigs" },
              { name: "gkenetworkparamsets" },
              { name: "managedcertificates" },
              { name: "networks" },
              { name: "serviceattachments" },
            ],
          };
        }
        throw { statusCode: 404 };
      }),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      provider: "none",
      supportsFqdn: false,
    });
  });

  test("does not credit enforcement to the Calico CRDs alone", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "crd.projectcalico.org"
            ? [{ name: "felixconfigurations" }, { name: "ippools" }]
            : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledWith({
      group: "crd.projectcalico.org",
      version: "v1",
    });
    expect(capabilities.networkPolicy).toMatchObject({
      // GKE serves these CRDs with node enforcement switched off, so their
      // presence says a Calico dialect is installed, not that packets are
      // filtered. Without a probe the honest answer is that nobody checked.
      kubernetesNetworkPolicy: false,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "none",
      supportsFqdn: false,
      supportsHttpMethods: false,
      enforcementStatus: "unknown",
    });
  });

  test("reports GKE FQDN support when the FQDNNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.gke.io"
            ? [{ name: "fqdnnetworkpolicies" }]
            : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: true,
      awsApplicationNetworkPolicy: false,
      provider: "gke-fqdn",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("reports AWS FQDN support when the ApplicationNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.k8s.aws"
            ? [{ name: "applicationnetworkpolicies" }]
            : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("caches CRD inspection for the same Kubernetes API object", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };

    await getK8sCapabilitiesFromApi(customObjectsApi as never);
    await getK8sCapabilitiesFromApi(customObjectsApi as never);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(4);
  });

  test("reprobes after the capability cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };

    await getK8sCapabilitiesFromApi(customObjectsApi as never);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getK8sCapabilitiesFromApi(customObjectsApi as never);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(8);
  });

  describe("with a behavioural enforcement probe", () => {
    // Verdicts age out, so fixtures are dated relative to now rather than pinned.
    const PROBED_AT = new Date(Date.now() - 60_000).toISOString();

    function crdsFor(group: string | null, resource?: string) {
      return {
        getAPIResources: vi.fn(async ({ group: g }: { group: string }) => ({
          resources: g === group && resource ? [{ name: resource }] : [],
        })),
      };
    }

    function probeSource(control: string, treatment: string) {
      return {
        coreApi: {
          listNamespacedPod: vi.fn(async () => ({
            items: [
              ["control", control],
              ["treatment", treatment],
            ].map(([role, message]) => ({
              metadata: { labels: { "archestra.io/netpol-probe-role": role } },
              status: {
                containerStatuses: [
                  {
                    state: {
                      terminated: { message, finishedAt: PROBED_AT },
                    },
                  },
                ],
              },
            })),
          })),
        } as never,
        namespace: "archestra",
      };
    }

    test("credits enforcement on a cluster whose dataplane publishes no CRD", async () => {
      // GKE Dataplane V2, kindnet and the EKS VPC CNI enforce the standard API
      // and advertise nothing, which inference alone reads as "no enforcer" and
      // uses to disable the egress controls.
      const capabilities = await getK8sCapabilitiesFromApi(
        crdsFor(null) as never,
        probeSource("reachable", "blocked"),
      );

      expect(capabilities.networkPolicy).toMatchObject({
        kubernetesNetworkPolicy: true,
        provider: "kubernetes",
        supportsFqdn: false,
        enforcementSource: "probe",
        probe: "enforced",
        probedAt: PROBED_AT,
      });
    });

    test("overrides installed Calico CRDs when a probe shows nothing enforces", async () => {
      // GKE serves these CRDs with node enforcement switched off, which is the
      // state that let egress rules be accepted and silently ignored.
      const capabilities = await getK8sCapabilitiesFromApi(
        crdsFor("crd.projectcalico.org", "felixconfigurations") as never,
        probeSource("reachable", "reachable"),
      );

      expect(capabilities.networkPolicy).toMatchObject({
        kubernetesNetworkPolicy: false,
        provider: "none",
        supportsFqdn: false,
        enforcementSource: "probe",
        probe: "not-enforced",
      });
    });

    test("ignores the probe on AWS, where the kind it measures is never enforced", async () => {
      // The probe uses a plain NetworkPolicy, which the AWS VPC CNI accepts and
      // ignores, so the treatment arm gets through on a cluster that enforces
      // via ApplicationNetworkPolicy. Letting that count would drop the provider
      // to "none" and make the runtime delete the baseline doing the work.
      const capabilities = await getK8sCapabilitiesFromApi(
        crdsFor("networking.k8s.aws", "applicationnetworkpolicies") as never,
        probeSource("reachable", "reachable"),
      );

      expect(capabilities.networkPolicy).toMatchObject({
        kubernetesNetworkPolicy: true,
        provider: "aws-application-network-policy",
        supportsFqdn: true,
        awsApplicationNetworkPolicy: true,
        enforcementSource: "api-discovery",
      });
    });

    test("falls back to inference when the probe reached no conclusion", async () => {
      const capabilities = await getK8sCapabilitiesFromApi(
        crdsFor("cilium.io", "ciliumnetworkpolicies") as never,
        probeSource("blocked", "blocked"),
      );

      expect(capabilities.networkPolicy).toMatchObject({
        kubernetesNetworkPolicy: true,
        provider: "cilium",
        supportsFqdn: true,
        enforcementSource: "api-discovery",
        probe: "inconclusive",
      });
    });

    test("reports inference when no probe ran at all", async () => {
      const capabilities = await getK8sCapabilitiesFromApi(
        crdsFor("cilium.io", "ciliumnetworkpolicies") as never,
      );

      expect(capabilities.networkPolicy).toMatchObject({
        provider: "cilium",
        enforcementSource: "api-discovery",
        probe: "absent",
        probedAt: null,
      });
    });
  });
});

describe("enforcement decision matrix", () => {
  afterEach(() => {
    clearK8sCapabilitiesCache();
  });

  const CALICO = ["crd.projectcalico.org", "felixconfigurations"] as const;
  const CILIUM = ["cilium.io", "ciliumnetworkpolicies"] as const;
  const GKE_FQDN = ["networking.gke.io", "fqdnnetworkpolicies"] as const;
  const AWS_ANP = ["networking.k8s.aws", "applicationnetworkpolicies"] as const;
  const NO_CRD = [null, null] as const;

  type Crd = readonly [string | null, string | null];
  type Verdict = "enforced" | "not-enforced" | "inconclusive" | "absent";

  /** Arm messages the kubelet publishes for each verdict the reader derives. */
  const ARMS = {
    enforced: ["reachable", "blocked"],
    "not-enforced": ["reachable", "reachable"],
    inconclusive: ["blocked", "blocked"],
  } as const;

  function discovery([group, resource]: Crd) {
    return {
      getAPIResources: vi.fn(async ({ group: g }: { group: string }) => ({
        resources: g === group && resource ? [{ name: resource }] : [],
      })),
    };
  }

  function probeSource(verdict: Verdict) {
    if (verdict === "absent") return undefined;
    const [control, treatment] = ARMS[verdict];
    return {
      coreApi: {
        listNamespacedPod: vi.fn(async () => ({
          items: [
            ["control", control],
            ["treatment", treatment],
          ].map(([role, message]) => ({
            metadata: { labels: { "archestra.io/netpol-probe-role": role } },
            status: {
              containerStatuses: [
                {
                  state: {
                    terminated: {
                      message,
                      finishedAt: new Date(Date.now() - 60_000).toISOString(),
                    },
                  },
                },
              ],
            },
          })),
        })),
      } as never,
      namespace: "archestra",
    };
  }

  /**
   * One row per (cluster, probe outcome). `enforcing` is the ground truth the
   * dataplane would actually apply, so the assertion can derive whether the
   * reported answer is wrong and in which direction — rather than trusting a
   * hand-written verdict that could drift from the expectations beside it.
   */
  const MATRIX: Array<{
    id: string;
    cluster: string;
    enforcing: boolean;
    crd: Crd;
    probe: Verdict;
    provider: string;
    enforcementSource: "probe" | "api-discovery";
    enforcementStatus:
      | "verified-enforced"
      | "verified-not-enforced"
      | "unknown";
    supportsFqdn: boolean;
  }> = [
    // The probe reaches a verdict: it decides, except on AWS.
    {
      id: "gke-calico-enforcing",
      cluster: "GKE Standard, Calico addon enforcing",
      enforcing: true,
      crd: CALICO,
      probe: "enforced",
      provider: "kubernetes",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: false,
    },
    {
      id: "gke-calico-addon-not-enforcing",
      cluster: "GKE Standard, Calico CRDs served but node enforcement off",
      enforcing: false,
      crd: CALICO,
      probe: "not-enforced",
      provider: "none",
      enforcementSource: "probe",
      enforcementStatus: "verified-not-enforced",
      supportsFqdn: false,
    },
    {
      id: "gke-no-addon",
      cluster: "GKE Standard, no network policy addon",
      enforcing: false,
      crd: NO_CRD,
      probe: "not-enforced",
      provider: "none",
      enforcementSource: "probe",
      enforcementStatus: "verified-not-enforced",
      supportsFqdn: false,
    },
    {
      id: "gke-dataplane-v2",
      cluster: "GKE Dataplane V2 / Autopilot, no CRD published",
      enforcing: true,
      crd: NO_CRD,
      probe: "enforced",
      provider: "kubernetes",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: false,
    },
    {
      id: "gke-dataplane-v2-fqdn",
      cluster: "GKE Dataplane V2 serving FQDNNetworkPolicy",
      enforcing: true,
      crd: GKE_FQDN,
      probe: "enforced",
      provider: "gke-fqdn",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: true,
    },
    {
      id: "cilium",
      cluster: "Cilium",
      enforcing: true,
      crd: CILIUM,
      probe: "enforced",
      provider: "cilium",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: true,
    },
    {
      id: "kind-kindnet",
      cluster: "kind / Docker Desktop with kindnet",
      enforcing: true,
      crd: NO_CRD,
      probe: "enforced",
      provider: "kubernetes",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: false,
    },
    {
      id: "kind-flannel",
      cluster: "kind with flannel, no policy engine",
      enforcing: false,
      crd: NO_CRD,
      probe: "not-enforced",
      provider: "none",
      enforcementSource: "probe",
      enforcementStatus: "verified-not-enforced",
      supportsFqdn: false,
    },
    {
      id: "eks-vpc-cni-policy-disabled",
      cluster: "EKS VPC CNI with network policy disabled",
      enforcing: false,
      crd: NO_CRD,
      probe: "not-enforced",
      provider: "none",
      enforcementSource: "probe",
      enforcementStatus: "verified-not-enforced",
      supportsFqdn: false,
    },
    {
      id: "eks-vpc-cni-policy-enabled",
      cluster: "EKS VPC CNI enforcing, no ApplicationNetworkPolicy CRD",
      enforcing: true,
      crd: NO_CRD,
      probe: "enforced",
      provider: "kubernetes",
      enforcementSource: "probe",
      enforcementStatus: "verified-enforced",
      supportsFqdn: false,
    },
    {
      // The probe drives a plain NetworkPolicy, which this dataplane accepts and
      // ignores, so its "not-enforced" describes a dialect the runtime never
      // uses. Letting it win would drop the provider and delete the AWS baseline
      // doing the enforcing.
      id: "eks-application-network-policy",
      cluster: "EKS serving ApplicationNetworkPolicy",
      enforcing: true,
      crd: AWS_ANP,
      probe: "not-enforced",
      provider: "aws-application-network-policy",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: true,
    },

    // The probe reaches no verdict, so CRD discovery stands in.
    {
      id: "gke-calico-addon-not-enforcing-probe-absent",
      cluster: "GKE Standard, Calico CRDs served but node enforcement off",
      enforcing: false,
      crd: CALICO,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "gke-calico-addon-not-enforcing-probe-inconclusive",
      cluster: "GKE Standard, Calico CRDs served but node enforcement off",
      enforcing: false,
      crd: CALICO,
      probe: "inconclusive",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "gke-calico-enforcing-probe-absent",
      cluster: "GKE Standard, Calico addon enforcing",
      enforcing: true,
      crd: CALICO,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "gke-dataplane-v2-probe-absent",
      cluster: "GKE Dataplane V2 / Autopilot, no CRD published",
      enforcing: true,
      crd: NO_CRD,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "kind-kindnet-probe-absent",
      cluster: "kind / Docker Desktop with kindnet",
      enforcing: true,
      crd: NO_CRD,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "kind-flannel-probe-absent",
      cluster: "kind with flannel, no policy engine",
      enforcing: false,
      crd: NO_CRD,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "eks-vpc-cni-policy-enabled-probe-absent",
      cluster: "EKS VPC CNI enforcing, no ApplicationNetworkPolicy CRD",
      enforcing: true,
      crd: NO_CRD,
      probe: "absent",
      provider: "none",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: false,
    },
    {
      id: "eks-application-network-policy-probe-absent",
      cluster: "EKS serving ApplicationNetworkPolicy",
      enforcing: true,
      crd: AWS_ANP,
      probe: "absent",
      provider: "aws-application-network-policy",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: true,
    },
    {
      id: "cilium-probe-absent",
      cluster: "Cilium",
      enforcing: true,
      crd: CILIUM,
      probe: "absent",
      provider: "cilium",
      enforcementSource: "api-discovery",
      enforcementStatus: "unknown",
      supportsFqdn: true,
    },
  ];

  /**
   * Runs every row through the real decision logic and grades the answer against
   * ground truth. The summaries below depend on this rather than on the expected
   * `provider` beside each row, so they fail when the logic changes instead of
   * agreeing with a table that has drifted away from it.
   *
   * `enforcementStatus` is the claim being graded: it alone decides whether the
   * editor is frozen or merely annotated. "unknown" asserts nothing, so it can
   * never be wrong — which is the point of having it.
   */
  async function gradeMatrix() {
    const graded = [];
    for (const row of MATRIX) {
      const { networkPolicy } = await getK8sCapabilitiesFromApi(
        discovery(row.crd) as never,
        probeSource(row.probe),
      );
      clearK8sCapabilitiesCache();
      const status = networkPolicy.enforcementStatus;
      const claimsEnforced = status === "verified-enforced";
      graded.push({
        id: row.id,
        status,
        source: networkPolicy.enforcementSource,
        misreport:
          status === "unknown" || claimsEnforced === row.enforcing
            ? null
            : claimsEnforced
              ? "false-negative"
              : "false-positive",
      });
    }
    return graded;
  }

  test.each(MATRIX)("$id: $cluster, probe=$probe", async ({
    crd,
    probe,
    provider,
    enforcementSource,
    enforcementStatus,
    supportsFqdn,
  }) => {
    const capabilities = await getK8sCapabilitiesFromApi(
      discovery(crd) as never,
      probeSource(probe),
    );

    expect(capabilities.networkPolicy).toMatchObject({
      provider,
      enforcementSource,
      enforcementStatus,
      supportsFqdn,
      probe,
      kubernetesNetworkPolicy: provider !== "none",
    });
  });

  test("no cluster in the matrix is misreported in either direction", async () => {
    const wrong = (await gradeMatrix()).filter((row) => row.misreport !== null);

    expect(wrong).toEqual([]);
  });

  test("discovery picks a dialect but never claims the cluster enforces", async () => {
    const claimed = (await gradeMatrix())
      .filter(
        (row) => row.source === "api-discovery" && row.status !== "unknown",
      )
      .map((row) => row.id);

    // Serving a policy CRD says which dialect to write, never that packets are
    // filtered. Only the probe watches one, so only the probe may verify.
    expect(claimed).toEqual([]);
  });

  test("an unverified cluster with Calico installed says where to look", async () => {
    const { networkPolicy } = await getK8sCapabilitiesFromApi(
      discovery(CALICO) as never,
    );

    expect(networkPolicy.enforcementStatus).toBe("unknown");
    expect(networkPolicy.message).toContain("Calico CRDs are installed");
    expect(networkPolicy.message).toContain("node enforcement switched off");
  });

  test("an unverified cluster without Calico does not mention it", async () => {
    const { networkPolicy } = await getK8sCapabilitiesFromApi(
      discovery(NO_CRD) as never,
    );

    expect(networkPolicy.enforcementStatus).toBe("unknown");
    expect(networkPolicy.message).not.toContain("Calico");
  });

  test("an unmeasured Calico cluster does not claim enforcement it lacks", async () => {
    const graded = await gradeMatrix();

    // The failure this whole mechanism exists to prevent: Calico CRDs served
    // with node enforcement off must not read as enforced, or the banner is
    // hidden over egress rules the cluster accepts and drops.
    expect(
      graded.find(
        (row) => row.id === "gke-calico-addon-not-enforcing-probe-absent",
      ),
    ).toMatchObject({ status: "unknown", misreport: null });
  });
});
