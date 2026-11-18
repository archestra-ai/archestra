import { ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { environmentClusters } from "@/k8s/environment-clusters";
import { EnvironmentModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { User } from "@/types";

vi.mock("@/auth");

// The MCP runtime is a collaborator here: these tests are about what the
// environment API accepts, stores and returns. The cluster itself is faked at
// the network boundary below, and the real Kubernetes client talks to it.
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: true,
    validateNamespace: vi.fn(),
    startServer: vi.fn().mockResolvedValue(undefined),
    removeEnvironmentClusterDeployments: vi.fn().mockResolvedValue(undefined),
  },
}));

import { hasPermission } from "@/auth";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";

const mockHasPermission = hasPermission as Mock;

const CLUSTER = "https://cluster-b.test:6443";
const OTHER_CLUSTER = "https://cluster-c.test:6443";
const TOKEN = "canary-token-3f9a1c";
const ROTATED_TOKEN = "canary-token-rotated-77d2";

function kubeconfig(params: { server?: string; token?: string } = {}): string {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: workloads",
    "clusters:",
    "  - name: workloads",
    "    cluster:",
    `      server: ${params.server ?? CLUSTER}`,
    "users:",
    "  - name: platform",
    "    user:",
    `      token: ${params.token ?? TOKEN}`,
    "contexts:",
    "  - name: workloads",
    "    context:",
    "      cluster: workloads",
    "      user: platform",
    "",
  ].join("\n");
}

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
/** Tokens the fake cluster rejects, as a real one rejects a revoked token. */
let revokedTokens: Set<string>;
/** `<verb> <resource>` pairs the fake cluster's access reviews deny. */
let deniedAccess: Set<string>;

describe("Environment with its own Kubernetes cluster", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    vi.mocked(
      mcpServerRuntimeManager.removeEnvironmentClusterDeployments,
    ).mockResolvedValue(undefined);
    environmentClusters.stop();
    revokedTokens = new Set();
    deniedAccess = new Set();

    for (const cluster of [CLUSTER, OTHER_CLUSTER]) {
      server.use(
        http.post(
          `${cluster}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`,
          async ({ request }) => {
            const token = request.headers
              .get("authorization")
              ?.replace(/^Bearer /, "");
            if (!token || revokedTokens.has(token)) {
              return HttpResponse.json(
                { kind: "Status", code: 401, reason: "Unauthorized" },
                { status: 401 },
              );
            }
            const review = (await request.json()) as {
              spec: { resourceAttributes: { verb: string; resource: string } };
            };
            const { verb, resource } = review.spec.resourceAttributes;
            return HttpResponse.json({
              ...review,
              status: { allowed: !deniedAccess.has(`${verb} ${resource}`) },
            });
          },
        ),
      );
    }

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: environmentRoutes } = await import("./environment");
    await app.register(environmentRoutes);
  });

  afterEach(async () => {
    environmentClusters.stop();
    vi.restoreAllMocks();
    await app.close();
  });

  const create = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/environments",
      payload: {
        name: "workloads",
        namespace: "team-a",
        kubeconfig: kubeconfig(),
        ...payload,
      },
    });

  test("stores the kubeconfig and returns the cluster, never the credential", async () => {
    const created = await create();

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      kubeconfigServer: CLUSTER,
      namespace: "team-a",
    });
    expect(created.json()).not.toHaveProperty("kubeconfigSecretId");
    expect(created.body).not.toContain(TOKEN);

    const list = await app.inject({ method: "GET", url: "/api/environments" });
    expect(list.body).toContain(CLUSTER);
    expect(list.body).not.toContain(TOKEN);
    expect(list.body).not.toContain("kubeconfigSecretId");
  });

  test("refuses a kubeconfig that runs a credential plugin", async () => {
    const withExec = kubeconfig().replace(
      `      token: ${TOKEN}`,
      "      exec:\n        apiVersion: client.authentication.k8s.io/v1\n        command: aws",
    );

    const created = await create({ kubeconfig: withExec });

    expect(created.statusCode).toBe(400);
    await expect(
      EnvironmentModel.listForOrganization(organizationId),
    ).resolves.toHaveLength(0);
  });

  test("refuses a kubeconfig whose identity cannot deploy into the namespace, and names what is missing", async () => {
    deniedAccess.add("create deployments");

    const created = await create();

    expect(created.statusCode).toBe(400);
    expect(created.json().error.message).toContain("deployments");
    await expect(
      EnvironmentModel.listForOrganization(organizationId),
    ).resolves.toHaveLength(0);
  });

  test("refuses a second environment in the same namespace of the same cluster", async () => {
    expect((await create()).statusCode).toBe(200);

    const second = await create({ name: "workloads-again" });

    expect(second.statusCode).toBe(409);
    expect(
      (await create({ name: "other-ns", namespace: "team-b" })).statusCode,
    ).toBe(200);
  });

  test("refuses a replacement kubeconfig for a different cluster", async () => {
    const { id } = (await create()).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: { kubeconfig: kubeconfig({ server: OTHER_CLUSTER }) },
    });

    expect(patched.statusCode).toBe(400);
    expect(patched.json().error.message).toContain(OTHER_CLUSTER);
  });

  test("accepts a replacement kubeconfig after the stored credential was revoked", async () => {
    const { id } = (await create()).json();
    revokedTokens.add(TOKEN);

    // The editor sends the unchanged namespace along with the kubeconfig.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: {
        namespace: "team-a",
        kubeconfig: kubeconfig({ token: ROTATED_TOKEN }),
      },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.body).not.toContain(ROTATED_TOKEN);
    // The environment's clients now present the new credential.
    const row = await EnvironmentModel.findById(id);
    const clients = await environmentClusters.forEnvironment(row);
    await expect(
      clients.authApi.createSelfSubjectAccessReview({
        body: {
          spec: { resourceAttributes: { verb: "get", resource: "pods" } },
        },
      }),
    ).resolves.toMatchObject({ status: { allowed: true } });
  });

  test("refuses a namespace it cannot check because the stored credential no longer works", async () => {
    const { id } = (await create()).json();
    revokedTokens.add(TOKEN);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: { namespace: "team-b" },
    });

    expect(patched.statusCode).toBe(400);
    expect((await EnvironmentModel.findById(id))?.namespace).toBe("team-a");
  });

  test("a delete that cannot clean the cluster up is refused, keeps the environment, and can then skip the cleanup", async () => {
    const { id } = (await create()).json();
    vi.mocked(
      mcpServerRuntimeManager.removeEnvironmentClusterDeployments,
    ).mockRejectedValue(new Error("cluster unreachable"));

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/environments/${id}`,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.internal_code).toBe(
      ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
    );
    const marked = await EnvironmentModel.findById(id);
    expect(marked?.deletingAt).not.toBeNull();
    expect(marked?.kubeconfigSecretId).not.toBeNull();

    // Marked: it accepts no change, only another delete.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/environments/${id}`,
      payload: { description: "changed" },
    });
    expect(patched.statusCode).toBe(409);

    const skipped = await app.inject({
      method: "DELETE",
      url: `/api/environments/${id}?skipClusterCleanup=true`,
    });
    expect(skipped.statusCode).toBe(200);
    await expect(EnvironmentModel.findById(id)).resolves.toBeFalsy();
  });

  test("a delete removes the environment's workloads from its cluster first", async () => {
    const { id } = (await create()).json();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/environments/${id}`,
    });

    expect(deleted.statusCode).toBe(200);
    expect(
      mcpServerRuntimeManager.removeEnvironmentClusterDeployments,
    ).toHaveBeenCalledWith(expect.objectContaining({ id }));
    await expect(EnvironmentModel.findById(id)).resolves.toBeFalsy();
  });
});
