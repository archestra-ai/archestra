import { EventEmitter } from "node:events";
import { Exec, KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import type WebSocket from "ws";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import { a2aTaskRunService } from "@/agents/a2a/a2a-task-run-service";
import {
  A2AArtifactModel,
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
} from "@/models";
import { afterEach, test as base, beforeEach, expect } from "@/test";
import { useMswServer } from "@/test/msw";
import type { AgentRunRecord } from "@/types";
import manager from "./manager";
import { AGENT_RUNTIME_TASK_LABEL } from "./naming";

// The singleton caches clients: keep this fake cluster out of shared workers.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: { enabled: true },
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

const origin = "https://kubernetes.example.test";
const sandboxUrl = `${origin}/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/:name/status`;
const podsUrl = `${origin}/api/v1/namespaces/test/pods`;
// biome-ignore lint/correctness/useHookAtTopLevel: MSW test lifecycle helper, not a React hook.
const server = useMswServer();
const test = base.extend<{ run: AgentRunRecord }>({
  run: async ({ makeOrganization, makeUser, makeAgent }, use) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    await use(
      await AgentRunModel.create({
        taskId: task.id,
        agentId: agent.id,
        organizationId: organization.id,
        actorKind: "user",
        actorId: user.id,
        actorUserId: user.id,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName: "completion-test",
      }),
    );
  },
});

beforeEach(() => {
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
    function (this: KubeConfig) {
      this.loadFromOptions({
        clusters: [{ name: "test", server: origin }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
    },
  );
  server.use(
    http.get(sandboxUrl, () => HttpResponse.json({ status: {} })),
    http.get(podsUrl, () =>
      HttpResponse.json({
        items: [{ metadata: { name: "worker" }, status: { phase: "Running" } }],
      }),
    ),
  );
  completeExec();
});
afterEach(async () => {
  await a2aTaskRunService.failInFlightRuns();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const endpoint of [sandboxUrl, podsUrl]) {
  test.for([
    429, 500, 502, 503, 504,
  ])(`recovers HTTP %i from ${endpoint} without losing the result`, async (status, {
    run,
  }) => {
    let requests = 0;
    server.use(
      http.get(endpoint, () => {
        requests++;
        if (requests <= 3)
          return HttpResponse.json(
            { message: "temporarily unavailable" },
            { status },
          );
        return endpoint === sandboxUrl
          ? HttpResponse.json({ status: {} })
          : HttpResponse.json({
              items: [
                { metadata: { name: "worker" }, status: { phase: "Running" } },
              ],
            });
      }),
    );
    await expect(
      manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(requests).toBe(4);
  });

  test(`recovers a real request timeout from ${endpoint}`, async ({ run }) => {
    // Keep the production HTTP client and AbortSignal; shorten only the clock.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(50));
    let requests = 0;
    server.use(
      http.get(endpoint, async ({ request }) => {
        requests++;
        if (requests === 1) {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        }
        return endpoint === sandboxUrl
          ? HttpResponse.json({ status: {} })
          : HttpResponse.json({
              items: [
                { metadata: { name: "worker" }, status: { phase: "Running" } },
              ],
            });
      }),
    );
    await expect(
      manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(requests).toBe(2);
  });
}

test.for([
  "disconnect",
  "timeout",
  "ECONNRESET",
  "ETIMEDOUT",
])("recovers a result-read %s", async (failure, { run }) => {
  let attempts = 0;
  const success = completeExec();
  const original = success.getMockImplementation();
  if (!original) throw new Error("Missing exec boundary");
  if (failure === "timeout") {
    const timer = setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => timer(fn, ms === 30_000 ? 10 : ms, ...rest)) as typeof setTimeout);
  }
  success.mockImplementation(async (...args) => {
    attempts++;
    if (attempts > 1) return original(...args);
    if (failure === "ECONNRESET" || failure === "ETIMEDOUT")
      throw Object.assign(new Error("connection lost"), { code: failure });
    const connection = socket();
    if (failure === "disconnect") setTimeout(() => connection.emit("close"), 0);
    return connection;
  });
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).resolves.toEqual({ outcome: "succeeded" });
  expect(attempts).toBe(2);
});

test("keeps monitoring a sustained outage with capped backoff and cancels during the wait", async ({
  run,
}) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let requests = 0;
  server.use(
    http.get(sandboxUrl, () => {
      requests++;
      return new HttpResponse(null, { status: 503 });
    }),
  );
  const result = manager.waitForCompletion({
    session: run,
    abortSignal: controller.signal,
  });
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  // Drive more failures than a conventional retry budget. A monitoring outage
  // must never become permission to stop an independently running worker.
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(30_000);
  expect(settled).toBe(false);
  expect(requests).toBeGreaterThanOrEqual(12);
  expect(requests).toBeLessThanOrEqual(16);
  controller.abort();
  await expect(result).resolves.toEqual({ outcome: "aborted" });
  const count = requests;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests).toBe(count);
});

test.for([
  0, 7,
])("still returns the worker's actual exit status %i after an outage", async (exitCode, {
  run,
}) => {
  server.use(
    http.get(sandboxUrl, () => new HttpResponse(null, { status: 503 }), {
      once: true,
    }),
  );
  completeExec(String(exitCode));
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).resolves.toEqual(
    exitCode === 0
      ? { outcome: "succeeded" }
      : {
          outcome: "failed",
          reason: "The Agent Runtime turn exited with status 7",
        },
  );
});

test("still fails when the sandbox was deleted", async ({ run }) => {
  server.use(
    http.get(sandboxUrl, () => new HttpResponse(null, { status: 404 })),
  );
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).resolves.toEqual({
    outcome: "failed",
    reason: "The Agent Sandbox no longer exists",
  });
});

test.for([
  "Finished",
  "SandboxExpired",
])("still fails on confirmed sandbox %s", async (condition, { run }) => {
  server.use(
    http.get(sandboxUrl, () =>
      HttpResponse.json({
        status: {
          conditions: [
            {
              type: condition,
              reason: condition,
              status: "True",
              message: "Workspace ended",
            },
          ],
        },
      }),
    ),
  );
  completeExec("");
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).resolves.toEqual({ outcome: "failed", reason: "Workspace ended" });
});

test.for([
  401, 403, 422,
])("does not hide permanent HTTP %i failures", async (status, { run }) => {
  let requests = 0;
  server.use(
    http.get(sandboxUrl, () => {
      requests++;
      return new HttpResponse(null, { status });
    }),
  );
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).rejects.toMatchObject({ code: status });
  expect(requests).toBe(1);
});

test("does not retry a command that actually failed", async ({ run }) => {
  vi.spyOn(Exec.prototype, "exec").mockImplementation(async (...args) => {
    args[8]?.({ status: "Failure" });
    return socket();
  });
  await expect(
    manager.waitForCompletion({ session: run, pollIntervalMs: 1 }),
  ).rejects.toThrow("Command in Agent Runtime pod failed");
});

test.for([
  "success",
  "worker-failure",
  "cancel",
] as const)("re-adopted lifecycle preserves work through a timeout and settles %s correctly", async (outcome, {
  run,
}) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(100));
  const lifecycle = new A2AManager({ taskMode: "full" });
  const commands: string[] = [];
  let observations = 0;
  server.use(
    http.get(
      `${origin}/api/v1/namespaces/test/secrets/:name`,
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.delete(
      `${origin}/api/v1/namespaces/test/secrets/:name`,
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get(sandboxUrl.replace("/status", ""), () =>
      HttpResponse.json({
        metadata: { labels: { [AGENT_RUNTIME_TASK_LABEL]: run.taskId } },
        spec: {},
      }),
    ),
    http.get(sandboxUrl, async ({ request }) => {
      observations++;
      if (observations === 1) {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      } else {
        expect((await A2ATaskModel.findById(run.taskId))?.state).toBe(
          "TASK_STATE_WORKING",
        );
        expect(
          (await AgentRunModel.findByTaskId(run.taskId))?.endedAt,
        ).toBeNull();
        expect(commands.some((command) => command.includes(".cancel"))).toBe(
          false,
        );
        if (outcome === "cancel") {
          await lifecycle.cancelTask({
            actor: {
              kind: "user",
              id: run.actorId,
              organizationId: run.organizationId,
            },
            agentId: run.agentId,
            request: { id: run.taskId },
          });
          return new HttpResponse(null, { status: 503 });
        }
      }
      return HttpResponse.json({ status: {} });
    }),
  );
  vi.spyOn(Exec.prototype, "exec").mockImplementation(async (...args) => {
    const command = (args[3] as string[]).join(" ");
    commands.push(command);
    if (command.includes("read-turn-result"))
      args[4]?.write(outcome === "worker-failure" ? "7" : "0");
    else if (command.includes(".log"))
      args[4]?.write("===ARCHESTRA-FINAL-ANSWER===\nRecovered answer");
    args[8]?.({ status: "Success" });
    return socket();
  });
  const adoption = lifecycle.adoptAgentRun({
    taskId: run.taskId,
    session: run,
  });
  if (outcome === "worker-failure")
    await expect(adoption).rejects.toThrow("turn exited with status 7");
  else await adoption;
  expect(observations).toBe(2);
  expect((await A2ATaskModel.findById(run.taskId))?.state).toBe(
    outcome === "success"
      ? "TASK_STATE_COMPLETED"
      : outcome === "cancel"
        ? "TASK_STATE_CANCELED"
        : "TASK_STATE_FAILED",
  );
  if (outcome === "success") {
    expect(await A2AArtifactModel.findByTaskId(run.taskId)).toEqual([
      expect.objectContaining({
        name: "agent-response",
        parts: [{ text: "Recovered answer" }],
      }),
    ]);
    expect(commands.some((command) => command.includes(".cancel"))).toBe(false);
  } else {
    expect(commands.some((command) => command.includes(".cancel"))).toBe(true);
  }
  expect(
    (await AgentRunModel.findByTaskId(run.taskId))?.endedAt,
  ).toBeInstanceOf(Date);
});

test("cancellation wins over a successful in-flight result read", async ({
  run,
}) => {
  const controller = new AbortController();
  vi.spyOn(Exec.prototype, "exec").mockImplementation(async (...args) => {
    controller.abort();
    args[4]?.write("0");
    args[8]?.({ status: "Success" });
    return socket();
  });
  await expect(
    manager.waitForCompletion({ session: run, abortSignal: controller.signal }),
  ).resolves.toEqual({ outcome: "aborted" });
});

test("an already canceled monitor makes no requests", async ({ run }) => {
  const exec = completeExec();
  let requests = 0;
  server.use(
    http.get(sandboxUrl, () => {
      requests++;
      return HttpResponse.json({ status: {} });
    }),
  );
  await expect(
    manager.waitForCompletion({
      session: run,
      abortSignal: AbortSignal.abort(),
    }),
  ).resolves.toEqual({ outcome: "aborted" });
  expect(requests).toBe(0);
  expect(exec).not.toHaveBeenCalled();
});

function socket(): WebSocket {
  return Object.assign(new EventEmitter(), {
    terminate: vi.fn(),
  }) as unknown as WebSocket;
}

function completeExec(output = "0") {
  return vi
    .spyOn(Exec.prototype, "exec")
    .mockImplementation(async (...args) => {
      args[4]?.write(output);
      args[8]?.({ status: "Success" });
      return socket();
    });
}
