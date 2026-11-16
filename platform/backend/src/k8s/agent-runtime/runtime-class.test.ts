import { KubeConfig, NodeV1Api } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import config from "@/config";
import { classifyAgentRunFailure } from "@/services/agent-runtime/run-failure";
import { useMswServer } from "@/test/msw";
import { agentRuntimeClassDetector } from "./runtime-class";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

const ORIGIN = "https://kubernetes.example.test";
const RUNTIME_CLASS_URL = `${ORIGIN}/apis/node.k8s.io/v1/runtimeclasses/:name`;
let previousRuntimeClassName: string | undefined;

beforeEach(() => {
  previousRuntimeClassName = config.agentRuntime.runtimeClassName;
  config.agentRuntime.runtimeClassName = "gvisor";
  agentRuntimeClassDetector.reset(nodeApi());
});

afterEach(() => {
  config.agentRuntime.runtimeClassName = previousRuntimeClassName;
  agentRuntimeClassDetector.reset();
});

test("refuses an unprivileged launch at once when the RuntimeClass does not exist", async () => {
  server.use(
    http.get(RUNTIME_CLASS_URL, () =>
      HttpResponse.json(
        { kind: "Status", code: 404, reason: "NotFound" },
        { status: 404 },
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

test("launches when the RuntimeClass exists, and when the platform may not read it", async () => {
  const seen: string[] = [];
  let status = 200;
  server.use(
    http.get(RUNTIME_CLASS_URL, ({ params }) => {
      seen.push(String(params.name));
      return status === 200
        ? HttpResponse.json({
            apiVersion: "node.k8s.io/v1",
            kind: "RuntimeClass",
            metadata: { name: params.name },
            handler: "runsc",
          })
        : HttpResponse.json(
            { kind: "Status", code: status, reason: "Forbidden" },
            { status },
          );
    }),
  );

  await expect(
    agentRuntimeClassDetector.assertUsable({ privileged: false }),
  ).resolves.toBeUndefined();
  expect(seen).toEqual(["gvisor"]);

  // Without RBAC the answer is unknown, which must not block runs.
  status = 403;
  agentRuntimeClassDetector.reset(nodeApi());
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

function nodeApi(): NodeV1Api {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: "test", server: ORIGIN }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  return kubeConfig.makeApiClient(NodeV1Api);
}
