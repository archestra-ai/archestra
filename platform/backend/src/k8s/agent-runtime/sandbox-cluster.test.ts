import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAgentRuntimeSandbox } from "./manifests";

// Explicit opt-in: this test creates a disposable Sandbox and PVC on OrbStack.
// Never infer the target from the user's current kubectl context.
describe.skipIf(process.env.ARCHESTRA_TEST_SANDBOX_CONTEXT !== "orbstack")(
  "Agent Sandbox controller integration",
  () => {
    it("keeps completed work and its files across suspension without replay", async () => {
      const taskId = randomUUID();
      const name = `sandbox-test-${taskId.slice(0, 8)}`;
      const manifest = buildAgentRuntimeSandbox({
        taskId,
        agentRuntimeId: randomUUID(),
        frozenName: name,
        namespace: "archestra-dev",
        image: "archestra-transcript-agent:test",
        command: [
          "/bin/sh",
          "-c",
          "printf first >> /home/node/result; printf container-state > /var/lib/docker/persistence-check; echo turn-finished",
        ],
        privileged: true,
        nodeSelector: {},
        resources: { cpuRequest: "100m", memoryRequest: "128Mi" },
        env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: taskId },
        secretEnv: {},
        activeDeadlineSeconds: 600,
        workspaceStorageSize: "1Gi",
        imagePullSecrets: [],
        ownerReferences: undefined,
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        inputFileCount: 0,
      });
      try {
        kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
        await until(() => readResult() === "0");
        expect(exec("cat /home/node/result")).toBe("first");
        expect(exec("cat /var/lib/docker/persistence-check")).toBe(
          "container-state",
        );
        expect(exec(`cat /var/run/archestra/turns/${taskId}.log`)).toContain(
          "turn-finished",
        );
        expect(exec("tmux has-session -t agent; echo attached")).toBe(
          "attached",
        );
        const originalPodUid = JSON.parse(
          kubectl(["get", "pod", podName(), "-o", "json"]),
        ).metadata.uid;
        const originalServiceFqdn = JSON.parse(
          kubectl(["get", "sandbox", name, "-o", "json"]),
        ).status.serviceFQDN;
        expect(originalServiceFqdn).toBeTruthy();
        kubectl([
          "patch",
          "sandbox",
          name,
          "--type=merge",
          "-p",
          JSON.stringify({ spec: { operatingMode: "Suspended" } }),
        ]);
        await until(() => !podName());
        kubectl([
          "patch",
          "sandbox",
          name,
          "--type=merge",
          "-p",
          JSON.stringify({ spec: { operatingMode: "Running" } }),
        ]);
        await until(
          () =>
            Boolean(podName()) &&
            JSON.parse(kubectl(["get", "pod", podName(), "-o", "json"]))
              .metadata.uid !== originalPodUid &&
            readResult() === "0",
        );
        expect(exec("cat /home/node/result")).toBe("first");
        expect(exec("cat /var/lib/docker/persistence-check")).toBe(
          "container-state",
        );
        expect(
          JSON.parse(kubectl(["get", "sandbox", name, "-o", "json"])).status
            .serviceFQDN,
        ).toBe(originalServiceFqdn);
        expect(
          exec(
            `test ! -f /var/run/archestra/turns/${taskId}.request && echo clean`,
          ),
        ).toBe("clean");
        exec(
          "printf 'printf second >> /home/node/result\\n' > /var/run/archestra/turns/second.request",
        );
        await until(
          () => exec("cat /var/run/archestra/turns/second.exit") === "0",
        );
        expect(exec("cat /home/node/result")).toBe("firstsecond");
        expect(exec(`cat /var/run/archestra/turns/${taskId}.log`)).toContain(
          "turn-finished",
        );
        expect(exec("cat /var/run/archestra/turns/second.log")).not.toContain(
          "turn-finished",
        );
        // Expiry is enforced by the controller, even without an application
        // reconciler. Retain preserves the object for observable expiry.
        kubectl([
          "patch",
          "sandbox",
          name,
          "--type=merge",
          "-p",
          JSON.stringify({
            spec: { shutdownTime: new Date(Date.now() - 1000).toISOString() },
          }),
        ]);
        await until(() => {
          const expired = JSON.parse(
            kubectl(["get", "sandbox", name, "-o", "json"]),
          );
          return (
            !podName() &&
            expired.status?.conditions?.some(
              (condition: { type: string; reason?: string }) =>
                condition.type === "Ready" &&
                condition.reason === "SandboxExpired",
            )
          );
        });
        // Retain applies to shutdown, not explicit deletion: foreground GC
        // must remove the workspace PVC when the Sandbox is deleted.
        const pvcName = `workspace-${name}`;
        expect(kubectl(["get", "pvc", pvcName, "-o", "name"]).trim()).toBe(
          `persistentvolumeclaim/${pvcName}`,
        );
        kubectl([
          "delete",
          "sandbox",
          name,
          "--cascade=foreground",
          "--wait=false",
        ]);
        await until(
          () =>
            kubectl([
              "get",
              "pvc",
              pvcName,
              "--ignore-not-found",
              "-o",
              "name",
            ]).trim() === "",
        );
      } catch (error) {
        // This disposable fixture contains no credentials or user content.
        const diagnostics = podName()
          ? kubectl(["logs", podName(), "-c", "agent-runtime", "--tail=30"])
          : "No Pod was created";
        throw new Error(
          `${String(error)}\nSandbox diagnostics:\n${diagnostics}`,
        );
      } finally {
        kubectl([
          "delete",
          "sandbox",
          name,
          "--ignore-not-found",
          "--wait=false",
        ]);
      }

      function podName() {
        const pods = JSON.parse(
          kubectl([
            "get",
            "pods",
            "-l",
            `archestra.io/agent-run-task-id=${taskId}`,
            "-o",
            "json",
          ]),
        );
        return pods.items[0]?.metadata.name ?? "";
      }
      function exec(command: string) {
        return kubectl([
          "exec",
          podName(),
          "-c",
          "agent-runtime",
          "--",
          "/bin/sh",
          "-c",
          command,
        ]).trim();
      }
      function readResult() {
        return exec(`cat /var/run/archestra/turns/${taskId}.exit`);
      }
    }, 180_000);
  },
);

function kubectl(args: string[], input?: string) {
  const result = spawnSync(
    "kubectl",
    ["--context=orbstack", "-n", "archestra-dev", ...args],
    { input, encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  return result.stdout;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Sandbox did not reach expected state: ${String(lastError)}`);
}
