import type {
  V1ContainerStatus,
  V1Deployment,
  V1OwnerReference,
  V1Pod,
  V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";
import { type SreClusterSnapshot, sreCandidates } from "./sre-sources";

const NOW = new Date("2026-11-16T12:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const NS = "mcp";
const LONG_AGO = ago(30 * 24 * HOUR);

describe("sre_oom_killed", () => {
  test("reports a recent OOMKilled termination at workload/container level", () => {
    const [candidate, ...rest] = run({
      pods: [
        apiPod("api-7d9f-a", {
          containers: [
            container("app", {
              restarts: 2,
              terminated: ["OOMKilled", ago(HOUR)],
            }),
          ],
        }),
      ],
      deployments: [apiDeployment()],
    });
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      fingerprint: "sre_oom_killed:mcp/Deployment/api/app",
      source: "sre_oom_killed",
      severity: "warn",
      evidence: [
        {
          type: "k8s_workload",
          namespace: NS,
          kind: "Deployment",
          name: "api",
        },
        { type: "k8s_pod", namespace: NS, name: "api-7d9f-a" },
      ],
    });
  });

  test.each([
    [4, "warn"],
    [5, "critical"],
  ])("%i restarts → %s", (restarts, severity) => {
    expect(
      severities(
        run({
          pods: [
            apiPod("api-7d9f-a", {
              containers: [
                container("app", {
                  restarts,
                  terminated: ["OOMKilled", ago(HOUR)],
                }),
              ],
            }),
          ],
          deployments: [apiDeployment()],
        }),
      ),
    ).toEqual([["sre_oom_killed", severity]]);
  });

  test("ignores a termination exactly 24h old and reports one just inside", () => {
    const pods = [
      apiPod("api-7d9f-a", {
        containers: [
          container("old", { terminated: ["OOMKilled", ago(24 * HOUR)] }),
          container("new", {
            terminated: ["OOMKilled", ago(24 * HOUR - SECOND)],
          }),
        ],
      }),
    ];
    expect(fingerprints(run({ pods, deployments: [apiDeployment()] }))).toEqual(
      ["sre_oom_killed:mcp/Deployment/api/new"],
    );
  });

  test("counts the current terminated state as the last termination", () => {
    const pods = [
      apiPod("api-7d9f-a", {
        containers: [
          {
            name: "app",
            image: "img",
            imageID: "",
            ready: false,
            restartCount: 0,
            state: {
              terminated: {
                exitCode: 137,
                reason: "OOMKilled",
                finishedAt: ago(MINUTE),
              },
            },
          },
        ],
      }),
    ];
    expect(fingerprints(run({ pods, deployments: [apiDeployment()] }))).toEqual(
      ["sre_oom_killed:mcp/Deployment/api/app"],
    );
  });

  test("an OOM-looping container is reported as OOM only, not also as a restart loop", () => {
    expect(
      severities(
        run({
          pods: [
            apiPod("api-7d9f-a", {
              containers: [
                container("app", {
                  restarts: 12,
                  terminated: ["OOMKilled", ago(MINUTE)],
                }),
              ],
            }),
          ],
          deployments: [apiDeployment()],
        }),
      ),
    ).toEqual([["sre_oom_killed", "critical"]]);
  });
});

describe("sre_restart_loop", () => {
  test.each([
    {
      restarts: 6,
      finished: ago(HOUR),
      expected: [["sre_restart_loop", "warn"]],
    },
    { restarts: 5, finished: ago(HOUR), expected: [] },
    { restarts: 6, finished: ago(24 * HOUR), expected: [] },
    {
      restarts: 6,
      finished: ago(24 * HOUR - SECOND),
      expected: [["sre_restart_loop", "warn"]],
    },
  ])("restarts=$restarts finished=$finished", ({
    restarts,
    finished,
    expected,
  }) => {
    const candidates = run({
      pods: [
        apiPod("api-7d9f-a", {
          containers: [
            container("app", { restarts, terminated: ["Error", finished] }),
          ],
        }),
      ],
      deployments: [apiDeployment()],
    });
    expect(severities(candidates)).toEqual(expected);
    if (expected.length > 0) {
      expect(fingerprints(candidates)).toEqual([
        "sre_restart_loop:mcp/Deployment/api/app",
      ]);
    }
  });
});

describe("sre_pod_stuck", () => {
  test.each([
    ["CrashLoopBackOff", "critical"],
    ["ImagePullBackOff", "warn"],
    ["ErrImagePull", "warn"],
  ])("waiting in %s → %s, fingerprinted per container", (reason, severity) => {
    const candidates = run({
      pods: [
        apiPod("api-7d9f-a", {
          containers: [container("app", { waiting: reason })],
        }),
      ],
      deployments: [apiDeployment()],
    });
    expect(severities(candidates)).toEqual([["sre_pod_stuck", severity]]);
    expect(fingerprints(candidates)).toEqual([
      "sre_pod_stuck:mcp/Deployment/api/app",
    ]);
  });

  test("ignores other waiting reasons", () => {
    expect(
      run({
        pods: [
          apiPod("api-7d9f-a", {
            containers: [container("app", { waiting: "ContainerCreating" })],
          }),
        ],
        deployments: [apiDeployment()],
      }),
    ).toEqual([]);
  });

  test("Pending exactly 10 minutes is not stuck; a second longer is, at pod-owner level", () => {
    const at = (age: number) =>
      run({
        pods: [apiPod("api-7d9f-a", { phase: "Pending", createdAt: ago(age) })],
        deployments: [apiDeployment()],
      });
    expect(at(10 * MINUTE)).toEqual([]);
    const candidates = at(10 * MINUTE + SECOND);
    expect(severities(candidates)).toEqual([["sre_pod_stuck", "warn"]]);
    expect(fingerprints(candidates)).toEqual([
      "sre_pod_stuck:mcp/Deployment/api",
    ]);
  });

  test("a Pending pod with a stuck container is reported per container only", () => {
    const candidates = run({
      pods: [
        apiPod("api-7d9f-a", {
          phase: "Pending",
          createdAt: ago(HOUR),
          containers: [container("app", { waiting: "ImagePullBackOff" })],
        }),
      ],
      deployments: [apiDeployment()],
    });
    expect(fingerprints(candidates)).toEqual([
      "sre_pod_stuck:mcp/Deployment/api/app",
    ]);
  });
});

describe("sre_replicas_unavailable", () => {
  test.each([
    {
      replicas: 3,
      available: 1,
      expected: [["sre_replicas_unavailable", "warn"]],
    },
    {
      replicas: 3,
      available: 0,
      expected: [["sre_replicas_unavailable", "critical"]],
    },
    { replicas: 3, available: 3, expected: [] },
    { replicas: 0, available: 0, expected: [] },
  ])("deployment $available/$replicas available", ({
    replicas,
    available,
    expected,
  }) => {
    const candidates = run({
      deployments: [apiDeployment({ replicas, available })],
    });
    expect(severities(candidates)).toEqual(expected);
    if (expected.length > 0) {
      expect(candidates[0]).toMatchObject({
        fingerprint: "sre_replicas_unavailable:mcp/Deployment/api",
        evidence: [
          {
            type: "k8s_workload",
            namespace: NS,
            kind: "Deployment",
            name: "api",
          },
        ],
      });
    }
  });

  test("uses ready replicas for a StatefulSet", () => {
    const candidates = run({
      statefulSets: [dbStatefulSet({ replicas: 2, ready: 0 })],
    });
    expect(severities(candidates)).toEqual([
      ["sre_replicas_unavailable", "critical"],
    ]);
    expect(fingerprints(candidates)).toEqual([
      "sre_replicas_unavailable:mcp/StatefulSet/db",
    ]);
  });

  test("a condition change exactly 10 minutes ago is too recent; a second older is not", () => {
    const at = (age: number) =>
      run({
        deployments: [
          apiDeployment({
            available: 0,
            conditions: [
              {
                type: "Available",
                status: "False",
                lastTransitionTime: ago(age),
              },
            ],
          }),
        ],
      });
    expect(at(10 * MINUTE)).toEqual([]);
    expect(fingerprints(at(10 * MINUTE + SECOND))).toEqual([
      "sre_replicas_unavailable:mcp/Deployment/api",
    ]);
  });

  test("a recently created deployment is not reported", () => {
    expect(
      run({
        deployments: [
          apiDeployment({ available: 0, createdAt: ago(5 * MINUTE) }),
        ],
      }),
    ).toEqual([]);
  });

  test("an unobserved spec change means the controller is still reacting", () => {
    expect(
      run({
        deployments: [
          apiDeployment({ available: 0, generation: 3, observedGeneration: 2 }),
        ],
      }),
    ).toEqual([]);
  });

  test("an unready pod that changed recently resets the window; old ones are evidence", () => {
    const deployments = [apiDeployment({ replicas: 2, available: 0 })];
    const fresh = apiPod("api-7d9f-new", { ready: ["False", ago(2 * MINUTE)] });
    const stale = apiPod("api-7d9f-old", { ready: ["False", ago(HOUR)] });
    expect(run({ deployments, pods: [stale, fresh] })).toEqual([]);
    expect(run({ deployments, pods: [stale] })[0]?.evidence).toEqual([
      { type: "k8s_workload", namespace: NS, kind: "Deployment", name: "api" },
      { type: "k8s_pod", namespace: NS, name: "api-7d9f-old" },
    ]);
  });

  test("a ready pod does not reset the window", () => {
    expect(
      fingerprints(
        run({
          deployments: [apiDeployment({ replicas: 2, available: 1 })],
          pods: [apiPod("api-7d9f-new", { ready: ["True", ago(MINUTE)] })],
        }),
      ),
    ).toEqual(["sre_replicas_unavailable:mcp/Deployment/api"]);
  });
});

describe("owner resolution", () => {
  const crashing = [container("app", { waiting: "CrashLoopBackOff" })];
  const ownerOf = (snapshot: Partial<SreClusterSnapshot>) =>
    run(snapshot).map((c) => c.evidence[0]);

  test("ReplicaSet → Deployment when the selector matches and the name is a prefix", () => {
    expect(
      ownerOf({
        pods: [apiPod("api-7d9f-a", { containers: crashing })],
        deployments: [apiDeployment()],
      }),
    ).toEqual([
      { type: "k8s_workload", namespace: NS, kind: "Deployment", name: "api" },
    ]);
  });

  test("selector mismatch keeps the ReplicaSet as owner", () => {
    expect(
      ownerOf({
        pods: [
          apiPod("api-7d9f-a", {
            containers: crashing,
            labels: { app: "other" },
          }),
        ],
        deployments: [apiDeployment()],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-7d9f",
      },
    ]);
  });

  test("a deployment whose name is not a prefix of the ReplicaSet is not the owner", () => {
    expect(
      ownerOf({
        pods: [apiPod("api-7d9f-a", { containers: crashing })],
        deployments: [apiDeployment({ name: "web" })],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-7d9f",
      },
    ]);
  });

  test("a matching deployment in another namespace is not the owner", () => {
    expect(
      ownerOf({
        pods: [apiPod("api-7d9f-a", { containers: crashing })],
        deployments: [apiDeployment({ namespace: "elsewhere" })],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-7d9f",
      },
    ]);
  });

  test("two candidate deployments are ambiguous and attribute nothing", () => {
    expect(
      ownerOf({
        pods: [
          apiPod("api-v2-7d9f-a", {
            containers: crashing,
            owner: rsOwner("api-v2-7d9f"),
          }),
        ],
        deployments: [apiDeployment(), apiDeployment({ name: "api-v2" })],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-v2-7d9f",
      },
    ]);
  });

  test("an empty selector attributes nothing", () => {
    expect(
      ownerOf({
        pods: [apiPod("api-7d9f-a", { containers: crashing })],
        deployments: [apiDeployment({ selector: {} })],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-7d9f",
      },
    ]);
  });

  test("matchExpressions are honoured", () => {
    const selector = {
      matchExpressions: [
        { key: "app", operator: "In", values: ["api"] },
        { key: "canary", operator: "DoesNotExist" },
      ],
    };
    const owner = (labels: Record<string, string>) =>
      ownerOf({
        pods: [apiPod("api-7d9f-a", { containers: crashing, labels })],
        deployments: [apiDeployment({ selector })],
      });
    expect(owner({ app: "api" })).toEqual([
      { type: "k8s_workload", namespace: NS, kind: "Deployment", name: "api" },
    ]);
    expect(owner({ app: "api", canary: "true" })).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "ReplicaSet",
        name: "api-7d9f",
      },
    ]);
  });

  test("StatefulSet and Job owners are taken directly", () => {
    expect(
      ownerOf({
        pods: [
          apiPod("db-0", {
            containers: crashing,
            owner: ownerRef("apps/v1", "StatefulSet", "db"),
          }),
          apiPod("backup-29001-x", {
            containers: crashing,
            owner: ownerRef("batch/v1", "Job", "backup-29001"),
          }),
        ],
      }),
    ).toEqual([
      {
        type: "k8s_workload",
        namespace: NS,
        kind: "Job",
        name: "backup-29001",
      },
      { type: "k8s_workload", namespace: NS, kind: "StatefulSet", name: "db" },
    ]);
  });

  test.each([
    ["no owner", undefined],
    [
      "a non-controller owner",
      { ...ownerRef("apps/v1", "StatefulSet", "db"), controller: false },
    ],
    [
      "an owner kind outside the workload set",
      ownerRef("v1", "Node", "node-1"),
    ],
    [
      "a known kind from the wrong API group",
      ownerRef("example.com/v1", "Deployment", "x"),
    ],
  ])("an orphan with %s is fingerprinted at pod level", (_label, owner) => {
    const candidates = run({
      pods: [apiPod("lonely", { containers: crashing, owner: owner ?? null })],
    });
    expect(candidates).toMatchObject([
      {
        fingerprint: "sre_pod_stuck:mcp/Pod/lonely/app",
        evidence: [{ type: "k8s_pod", namespace: NS, name: "lonely" }],
      },
    ]);
  });
});

describe("aggregation", () => {
  test("pods of one workload fold into one candidate with capped pod evidence and max severity", () => {
    const pods = [
      apiPod("api-7d9f-g", {
        containers: [container("app", { waiting: "ImagePullBackOff" })],
      }),
      ...["a", "b", "c", "d", "e", "f"].map((suffix) =>
        apiPod(`api-7d9f-${suffix}`, {
          containers: [
            container("app", {
              waiting: suffix === "f" ? "CrashLoopBackOff" : "ErrImagePull",
            }),
          ],
        }),
      ),
    ];
    const candidates = run({ pods, deployments: [apiDeployment()] });
    expect(severities(candidates)).toEqual([["sre_pod_stuck", "critical"]]);
    expect(candidates[0]?.evidence).toEqual([
      { type: "k8s_workload", namespace: NS, kind: "Deployment", name: "api" },
      ...["a", "b", "c", "d", "e"].map((s) => ({
        type: "k8s_pod",
        namespace: NS,
        name: `api-7d9f-${s}`,
      })),
    ]);
  });

  test("different containers of one workload stay separate issues", () => {
    expect(
      fingerprints(
        run({
          pods: [
            apiPod("api-7d9f-a", {
              containers: [
                container("app", { waiting: "CrashLoopBackOff" }),
                container("sidecar", { waiting: "CrashLoopBackOff" }),
              ],
            }),
          ],
          deployments: [apiDeployment()],
        }),
      ),
    ).toEqual([
      "sre_pod_stuck:mcp/Deployment/api/app",
      "sre_pod_stuck:mcp/Deployment/api/sidecar",
    ]);
  });

  test("fingerprints survive pod and ReplicaSet churn", () => {
    const scan = (rs: string, podName: string) =>
      fingerprints(
        run({
          pods: [
            apiPod(podName, {
              owner: rsOwner(rs),
              phase: "Pending",
              createdAt: ago(HOUR),
              containers: [
                container("app", {
                  restarts: 9,
                  terminated: ["Error", ago(MINUTE)],
                }),
                container("init", {
                  restarts: 1,
                  terminated: ["OOMKilled", ago(MINUTE)],
                }),
              ],
            }),
          ],
          deployments: [apiDeployment({ available: 0 })],
        }),
      );
    const first = scan("api-7d9f", "api-7d9f-a");
    expect(first).toEqual([
      "sre_oom_killed:mcp/Deployment/api/init",
      "sre_pod_stuck:mcp/Deployment/api",
      "sre_replicas_unavailable:mcp/Deployment/api",
      "sre_restart_loop:mcp/Deployment/api/app",
    ]);
    expect(scan("api-55c1", "api-55c1-z")).toEqual(first);
  });
});

// === Fixtures ===

function run(snapshot: Partial<SreClusterSnapshot>) {
  return sreCandidates(
    {
      pods: snapshot.pods ?? [],
      deployments: snapshot.deployments ?? [],
      statefulSets: snapshot.statefulSets ?? [],
    },
    NOW,
  );
}

function fingerprints(candidates: ReturnType<typeof run>): string[] {
  return candidates.map((c) => c.fingerprint);
}

function severities(candidates: ReturnType<typeof run>): string[][] {
  return candidates.map((c) => [c.source, c.severity]);
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function ownerRef(
  apiVersion: string,
  kind: string,
  name: string,
): V1OwnerReference {
  return { apiVersion, kind, name, uid: `uid-${name}`, controller: true };
}

function rsOwner(name: string): V1OwnerReference {
  return ownerRef("apps/v1", "ReplicaSet", name);
}

function apiPod(
  name: string,
  opts: {
    owner?: V1OwnerReference | null;
    labels?: Record<string, string>;
    phase?: string;
    createdAt?: Date;
    containers?: V1ContainerStatus[];
    ready?: [status: string, at: Date];
  } = {},
): V1Pod {
  const owner = opts.owner === undefined ? rsOwner("api-7d9f") : opts.owner;
  return {
    metadata: {
      name,
      namespace: NS,
      labels: opts.labels ?? { app: "api", "pod-template-hash": "7d9f" },
      creationTimestamp: opts.createdAt ?? LONG_AGO,
      ownerReferences: owner ? [owner] : undefined,
    },
    status: {
      phase: opts.phase ?? "Running",
      containerStatuses: opts.containers ?? [],
      conditions: opts.ready
        ? [
            {
              type: "Ready",
              status: opts.ready[0],
              lastTransitionTime: opts.ready[1],
            },
          ]
        : undefined,
    },
  };
}

function container(
  name: string,
  opts: {
    restarts?: number;
    terminated?: [reason: string, at: Date];
    waiting?: string;
  },
): V1ContainerStatus {
  return {
    name,
    image: "registry.example/app:1",
    imageID: "",
    ready: false,
    restartCount: opts.restarts ?? 0,
    state: opts.waiting
      ? { waiting: { reason: opts.waiting } }
      : { running: {} },
    lastState: opts.terminated
      ? {
          terminated: {
            exitCode: opts.terminated[0] === "OOMKilled" ? 137 : 1,
            reason: opts.terminated[0],
            finishedAt: opts.terminated[1],
          },
        }
      : undefined,
  };
}

function apiDeployment(
  opts: {
    name?: string;
    namespace?: string;
    selector?: NonNullable<V1Deployment["spec"]>["selector"];
    replicas?: number;
    available?: number;
    createdAt?: Date;
    generation?: number;
    observedGeneration?: number;
    conditions?: NonNullable<V1Deployment["status"]>["conditions"];
  } = {},
): V1Deployment {
  const replicas = opts.replicas ?? 1;
  return {
    metadata: {
      name: opts.name ?? "api",
      namespace: opts.namespace ?? NS,
      creationTimestamp: opts.createdAt ?? LONG_AGO,
      generation: opts.generation ?? 1,
    },
    spec: {
      replicas,
      selector: opts.selector ?? { matchLabels: { app: "api" } },
      template: {},
    },
    status: {
      availableReplicas: opts.available ?? replicas,
      observedGeneration: opts.observedGeneration ?? opts.generation ?? 1,
      conditions: opts.conditions,
    },
  };
}

function dbStatefulSet(opts: {
  replicas: number;
  ready: number;
}): V1StatefulSet {
  return {
    metadata: {
      name: "db",
      namespace: NS,
      creationTimestamp: LONG_AGO,
      generation: 1,
    },
    spec: {
      replicas: opts.replicas,
      selector: { matchLabels: { app: "db" } },
      serviceName: "db",
      template: {},
    },
    status: {
      replicas: opts.replicas,
      readyReplicas: opts.ready,
      observedGeneration: 1,
    },
  };
}
