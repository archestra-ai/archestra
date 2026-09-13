import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { claudeCodeAccountRuntime } from "./claude-code-account";
import { execAgentRuntimeCommand } from "./exec";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: { enabled: true },
  }),
);

// Only Kubernetes transport and native subprocess execution are substituted.
vi.mock("@/k8s/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/shared")>()),
  loadKubeConfig: () => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.example.test" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    return { kubeConfig, namespace: "account-tests" };
  },
}));
vi.mock("./exec", () => ({ execAgentRuntimeCommand: vi.fn() }));
// biome-ignore lint/correctness/useHookAtTopLevel: This helper installs Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

beforeEach(() => {
  vi.mocked(execAgentRuntimeCommand).mockReset();
});

describe("disposable Claude sign-in Jobs", () => {
  test("installs owned egress policy before allowing the credential process to run, without storage", async () => {
    const order: string[] = [];
    server.use(
      http.get("https://kubernetes.example.test/apis/:group/:version", () =>
        HttpResponse.json({ resources: [] }),
      ),
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/configmaps/:name",
        () => HttpResponse.json({ data: {} }),
      ),
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/kube-system/services/kube-dns",
        () => HttpResponse.json({ spec: { clusterIP: "10.96.0.10" } }),
      ),
      http.post(
        "https://kubernetes.example.test/apis/batch/v1/namespaces/account-tests/jobs",
        async ({ request }) => {
          order.push("job");
          const job = (await request.json()) as {
            spec: {
              activeDeadlineSeconds: number;
              ttlSecondsAfterFinished: number;
              template: { spec: Record<string, unknown> };
            };
          };
          expect(job.spec.activeDeadlineSeconds).toBe(600);
          expect(job.spec.ttlSecondsAfterFinished).toBe(60);
          expect(job.spec).not.toHaveProperty("suspend");
          expect(job.spec.template.spec).toMatchObject({
            schedulingGates: [{ name: "archestra.io/egress-ready" }],
            automountServiceAccountToken: false,
          });
          expect(job.spec.template.spec).not.toHaveProperty("volumes");
          expect(JSON.stringify(job)).not.toContain("persistentVolumeClaim");
          return HttpResponse.json({
            ...job,
            metadata: { name: `claude-sign-in-${FLOW.flowId}`, uid: "job-uid" },
          });
        },
      ),
      http.post(
        "https://kubernetes.example.test/apis/networking.k8s.io/v1/namespaces/account-tests/networkpolicies",
        async ({ request }) => {
          order.push("policy");
          expect(await request.json()).toMatchObject({
            metadata: {
              ownerReferences: [
                { apiVersion: "batch/v1", kind: "Job", uid: "job-uid" },
              ],
            },
          });
          return HttpResponse.json({});
        },
      ),
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/pods",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("labelSelector")).toBe(
            `job-name=claude-sign-in-${FLOW.flowId}`,
          );
          return HttpResponse.json({
            items: [
              {
                metadata: { name: "sign-in-pod" },
                spec: {
                  schedulingGates: [
                    { name: "other.test/gate" },
                    { name: "archestra.io/egress-ready" },
                  ],
                },
              },
            ],
          });
        },
      ),
      http.patch(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/pods/sign-in-pod",
        async ({ request }) => {
          order.push("schedule");
          expect(await request.json()).toEqual([
            { op: "remove", path: "/spec/schedulingGates/1" },
          ]);
          return HttpResponse.json({});
        },
      ),
    );
    await claudeCodeAccountRuntime.create({
      ...FLOW,
      image: "example.test/claude:test",
      agentId: "test-agent",
      vaultReference: false,
      effectiveNetworkPolicy: { source: "built_in", policy: null },
    });
    expect(order).toEqual(["job", "policy", "schedule"]);
  });

  test("passes authorization data on stdin and returns only native status for the selected flow", async () => {
    server.use(
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/pods",
        () =>
          HttpResponse.json({
            items: [
              {
                metadata: { name: "sign-in-pod" },
                status: { phase: "Running" },
              },
            ],
          }),
      ),
    );
    vi.mocked(execAgentRuntimeCommand).mockImplementation(
      async ({ stdin, command }) => {
        expect(command).toEqual(["archestra-claude-account", "complete"]);
        let input = "";
        for await (const chunk of stdin ?? []) input += chunk;
        expect(JSON.parse(input)).toEqual({
          flowId: FLOW.flowId,
          code: "example-code",
        });
        return JSON.stringify({ state: "connecting" });
      },
    );
    expect(
      await claudeCodeAccountRuntime.complete({
        ...FLOW,
        code: "example-code",
      }),
    ).toEqual({ state: "connecting" });
    vi.mocked(execAgentRuntimeCommand).mockResolvedValue(
      "malformed-private-output",
    );
    await expect(claudeCodeAccountRuntime.status(FLOW)).rejects.toThrow(
      "invalid account data",
    );
  });

  test.each([
    {
      status: { phase: "Pending" },
      expected: { state: "starting", startupPhase: "scheduling" },
    },
    {
      status: {
        phase: "Pending",
        conditions: [{ type: "PodScheduled", status: "True" }],
      },
      expected: { state: "starting", startupPhase: "pulling" },
    },
    {
      status: {
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "private cluster detail",
          },
        ],
      },
      expected: {
        state: "starting",
        startupPhase: "scheduling",
        startupIssue: "capacity",
      },
    },
    ...["ErrImagePull", "ImagePullBackOff", "InvalidImageName"].map(
      (reason) => ({
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              name: "claude-code",
              state: {
                waiting: { reason, message: "private registry detail" },
              },
            },
          ],
        },
        expected: { state: "failed", startupIssue: "image_pull" },
      }),
    ),
    {
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "claude-code",
            state: { waiting: { reason: "CrashLoopBackOff" } },
          },
        ],
      },
      expected: { state: "failed", startupIssue: "container" },
    },
  ])("reports startup progress and actionable failures without exposing cluster details: $expected", async ({
    status,
    expected,
  }) => {
    server.use(
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/pods",
        () =>
          HttpResponse.json({
            items: [{ metadata: { name: "sign-in-pod" }, status }],
          }),
      ),
    );
    const result = await claudeCodeAccountRuntime.status(FLOW);
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(execAgentRuntimeCommand).not.toHaveBeenCalled();
  });

  test("handles pending and stopped pods, and cleanup after automatic Job collection", async () => {
    let phase = "Pending";
    server.use(
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/account-tests/pods",
        () =>
          HttpResponse.json({
            items: [{ metadata: { name: "sign-in-pod" }, status: { phase } }],
          }),
      ),
      http.delete(
        "https://kubernetes.example.test/apis/batch/v1/namespaces/account-tests/jobs/:name",
        () =>
          HttpResponse.json(
            { kind: "Status", code: 404, reason: "NotFound" },
            { status: 404 },
          ),
      ),
    );
    expect(await claudeCodeAccountRuntime.status(FLOW)).toMatchObject({
      state: "starting",
    });
    phase = "Failed";
    expect(await claudeCodeAccountRuntime.complete(FLOW)).toEqual({
      state: "failed",
    });
    expect(execAgentRuntimeCommand).not.toHaveBeenCalled();
    await expect(
      claudeCodeAccountRuntime.delete(FLOW),
    ).resolves.toBeUndefined();
  });
});
const FLOW = {
  namespace: "account-tests",
  flowId: "00000000-0000-4000-8000-000000000001",
};
