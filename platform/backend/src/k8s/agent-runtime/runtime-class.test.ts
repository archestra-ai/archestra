import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import config from "@/config";
import { classifyAgentRunFailure } from "@/services/agent-runtime/run-failure";
import { useMswServer } from "@/test/msw";
import { agentRuntimeClassDetector } from "./runtime-class";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

const ORIGIN = "https://kubernetes.example.test";
const PODS_URL = `${ORIGIN}/api/v1/namespaces/:namespace/pods`;
let previousRuntimeClassName: string | undefined;
let previousNamespace: string | undefined;

beforeEach(() => {
  previousRuntimeClassName = config.agentRuntime.runtimeClassName;
  previousNamespace = config.agentRuntime.namespace;
  config.agentRuntime.runtimeClassName = "gvisor";
  config.agentRuntime.namespace = "agent-runtimes";
  agentRuntimeClassDetector.reset(coreApi());
});

afterEach(() => {
  config.agentRuntime.runtimeClassName = previousRuntimeClassName;
  config.agentRuntime.namespace = previousNamespace;
  agentRuntimeClassDetector.reset();
});

test("refuses an unprivileged launch at once when the RuntimeClass does not exist", async () => {
  server.use(
    http.post(PODS_URL, () =>
      // What the API server's RuntimeClass admission answers.
      HttpResponse.json(
        {
          kind: "Status",
          status: "Failure",
          code: 403,
          reason: "Forbidden",
          message:
            'pods "archestra-runtime-class-check-" is forbidden: pod rejected: RuntimeClass "gvisor" not found',
        },
        { status: 403 },
      ),
    ),
  );

  const error = await agentRuntimeClassDetector
    .assertUsable({ privileged: false })
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    statusCode: 409,
    message: expect.stringContaining(
      'The RuntimeClass "gvisor" set in ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME does not exist',
    ),
  });
  expect(classifyAgentRunFailure(error)).toEqual({
    code: "launch.misconfigured",
    retriable: false,
  });
  // A privileged run never uses the RuntimeClass.
  await expect(
    agentRuntimeClassDetector.assertUsable({ privileged: true }),
  ).resolves.toBeUndefined();
});

test("checks with a dry-run pod in the Agent Runtime namespace, and launches when it is admitted", async () => {
  const seen: Array<{
    namespace: string;
    dryRun: string | null;
    runtimeClassName?: string;
  }> = [];
  server.use(
    http.post(PODS_URL, async ({ params, request }) => {
      const body = (await request.json()) as {
        spec?: { runtimeClassName?: string };
      };
      seen.push({
        namespace: String(params.namespace),
        dryRun: new URL(request.url).searchParams.get("dryRun"),
        runtimeClassName: body.spec?.runtimeClassName,
      });
      return HttpResponse.json(body, { status: 201 });
    }),
  );

  await expect(
    agentRuntimeClassDetector.assertUsable({ privileged: false }),
  ).resolves.toBeUndefined();
  expect(seen).toEqual([
    { namespace: "agent-runtimes", dryRun: "All", runtimeClassName: "gvisor" },
  ]);
});

test("launches when the check is rejected for another reason", async () => {
  server.use(
    http.post(PODS_URL, () =>
      HttpResponse.json(
        {
          kind: "Status",
          code: 403,
          reason: "Forbidden",
          message:
            'pods is forbidden: User "system:serviceaccount:archestra:platform" cannot create resource "pods"',
        },
        { status: 403 },
      ),
    ),
  );
  await expect(
    agentRuntimeClassDetector.assertUsable({ privileged: false }),
  ).resolves.toBeUndefined();
});

test("checks nothing when no RuntimeClass is configured", async () => {
  config.agentRuntime.runtimeClassName = undefined;
  // Any request would be unhandled by MSW and fail the test.
  await expect(
    agentRuntimeClassDetector.assertUsable({ privileged: false }),
  ).resolves.toBeUndefined();
});

function coreApi(): CoreV1Api {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  return kubeConfig.makeApiClient(CoreV1Api);
}
