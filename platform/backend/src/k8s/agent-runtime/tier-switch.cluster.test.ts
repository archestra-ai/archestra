import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "@/types";
import manager from "./manager";
import { buildAgentRuntimeSandbox } from "./manifests";
import { AGENT_RUNTIME_TIER_ANNOTATION } from "./naming";
import { agentSandboxApi } from "./sandbox-api";

// Real controller, PVC, privilege and exec integration. Opt in with the
// context to use (and a namespace); never the ambient kubectl context.
const CONTEXT = process.env.ARCHESTRA_TEST_SANDBOX_CONTEXT ?? "";
const NAMESPACE =
  process.env.ARCHESTRA_TEST_SANDBOX_NAMESPACE ?? "archestra-dev";
const IMAGE =
  process.env.ARCHESTRA_TEST_SANDBOX_TIER_IMAGE ??
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-claude-code:f80e33a1706019c355a80efb7343173f581ce042";

describe.skipIf(!CONTEXT)("Agent Runtime tier switch on a cluster", () => {
  it("moves a running turn to the Full tier and back without losing files or Docker data", async () => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    const load = KubeConfig.prototype.loadFromDefault;
    vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
      function (this: KubeConfig) {
        load.call(this);
        this.setCurrentContext(CONTEXT);
      },
    );
    const taskId = randomUUID();
    const name = `tier-switch-${taskId.slice(0, 8)}`;
    const session = {
      id: randomUUID(),
      taskId,
      workloadName: name,
      runtimeScope: NAMESPACE,
    } as AgentRunRecord;
    const light = {
      image: IMAGE,
      privileged: false,
      resources: { cpuRequest: "100m", memoryRequest: "128Mi" },
    };
    const full = {
      image: IMAGE,
      privileged: true,
      resources: { cpuRequest: "200m", memoryRequest: "256Mi" },
    };
    // The agent: records what it sees, waits for the switch on the first
    // run, and on the continuation writes Docker data and exits.
    const agent = [
      "log=/home/node/tier-log",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
      'if [ "${ARCHESTRA_AGENT_RUNTIME_CONTINUE:-0}" = 1 ]; then',
      '  printf "resumed %s %s\\n" "$ARCHESTRA_AGENT_RUNTIME_TIER" "$ARCHESTRA_AGENT_RUNTIME_TASK" >> "$log"',
      '  grep -q " /var/lib/docker " /proc/mounts && echo docker-mounted >> "$log"',
      "  echo docker-data > /var/lib/docker/persisted",
      "  exit 0",
      "fi",
      'printf "started %s\\n" "$ARCHESTRA_AGENT_RUNTIME_TIER" >> "$log"',
      "touch /var/run/archestra/waiting-for-switch",
      "sleep 600",
    ].join("\n");
    try {
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: `${name}-env` },
          stringData: {
            ARCHESTRA_AGENT_RUNTIME_RENEWABLE_CREDENTIALS: JSON.stringify({
              taskId,
              credentials: {},
            }),
          },
        }),
      );
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify(
          buildAgentRuntimeSandbox({
            taskId,
            agentRuntimeId: randomUUID(),
            frozenName: name,
            namespace: NAMESPACE,
            ...light,
            tier: "light",
            command: ["/bin/sh", "-c", agent],
            env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: taskId },
            secretEnv: {},
            activeDeadlineSeconds: 900,
            workspaceStorageSize: "1Gi",
            nodeSelector: {},
            imagePullSecrets: [],
            ownerReferences: undefined,
            effectiveNetworkPolicy: { source: "built_in", policy: null },
            inputFileCount: 0,
          }),
        ),
      );
      await until(
        () =>
          exec("test -f /var/run/archestra/waiting-for-switch && echo yes") ===
          "yes",
      );

      // Mid-turn: the turn continues on the Full tier as a continuation.
      expect(
        await manager.switchWorkspaceTier({
          session,
          tier: "full",
          settings: full,
          resumePrompt: "note-from-platform",
          shouldResume: async () => true,
        }),
      ).toBe(true);
      await until(
        () => exec(`cat /var/run/archestra/turns/${taskId}.exit`) === "0",
      );
      expect(exec("cat /home/node/tier-log").split("\n")).toEqual([
        "started light",
        "resumed full note-from-platform",
        "docker-mounted",
      ]);
      const sandbox = JSON.parse(
        kubectl(["get", "sandbox", name, "-o", "json"]),
      );
      expect(sandbox.metadata.annotations[AGENT_RUNTIME_TIER_ANNOTATION]).toBe(
        "full",
      );
      expect(podSpec().containers[0].securityContext).toEqual({
        privileged: true,
      });

      // Between turns: back to Lite. Files stay, Docker data stays on the
      // volume although the Lite Pod does not mount it.
      expect(
        await manager.switchWorkspaceTier({
          session,
          tier: "light",
          settings: light,
          resumePrompt: "unused",
          shouldResume: async () => true,
        }),
      ).toBe(true);
      expect(podSpec().containers[0].securityContext).toEqual({
        allowPrivilegeEscalation: false,
      });
      expect(exec("echo $ARCHESTRA_AGENT_RUNTIME_TIER")).toBe("light");
      expect(exec('grep -c " /var/lib/docker " /proc/mounts || true')).toBe(
        "0",
      );
      expect(exec("cat /home/node/tier-log")).toContain("docker-mounted");

      expect(
        await manager.switchWorkspaceTier({
          session,
          tier: "full",
          settings: full,
          resumePrompt: "unused",
          shouldResume: async () => true,
        }),
      ).toBe(true);
      expect(exec("cat /var/lib/docker/persisted")).toBe("docker-data");
      // The finished turn is not replayed by the replacement Pods.
      expect(exec("cat /home/node/tier-log").split("\n")).toHaveLength(3);
    } catch (error) {
      const diagnostics = podName()
        ? kubectl(["logs", podName(), "-c", "agent-runtime", "--tail=40"])
        : "No Pod was created";
      throw new Error(`${String(error)}\nSandbox diagnostics:\n${diagnostics}`);
    } finally {
      vi.restoreAllMocks();
      kubectl(["delete", "secret", `${name}-env`, "--ignore-not-found"]);
      kubectl([
        "delete",
        "sandbox",
        name,
        "--ignore-not-found",
        "--cascade=foreground",
        "--wait=false",
      ]);
    }

    function podName() {
      const pods = JSON.parse(
        kubectl([
          "get",
          "pods",
          "-l",
          `archestra.io/agent-workspace=${name}`,
          "-o",
          "json",
        ]),
      );
      return (
        pods.items.find(
          (pod: { metadata: { deletionTimestamp?: string } }) =>
            !pod.metadata.deletionTimestamp,
        )?.metadata.name ?? ""
      );
    }
    function podSpec() {
      return JSON.parse(kubectl(["get", "pod", podName(), "-o", "json"])).spec;
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
  }, 600_000);
});

function kubectl(args: string[], input?: string) {
  const result = spawnSync(
    "kubectl",
    [`--context=${CONTEXT}`, "-n", NAMESPACE, ...args],
    { input, encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  return result.stdout;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 180_000;
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
