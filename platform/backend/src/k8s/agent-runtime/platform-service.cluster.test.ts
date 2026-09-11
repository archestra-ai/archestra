import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  CoreV1Api,
  KubeConfig,
  type V1NetworkPolicy,
} from "@kubernetes/client-node";
import { expect, test } from "vitest";
import { buildAgentRuntimePlatformEgressPolicy } from "./manifests";
import { buildAgentRuntimeEnvironmentEgressPolicies } from "./network-policy";
import { resolvePlatformServiceDestination } from "./platform-service";

// Explicit local opt-in. Pod-local raw OUTPUT rules reproduce pre-DNAT
// enforcement with real Service routing; this does not run the AWS CNI.
// Build image: printf 'FROM node:22-alpine\nRUN apk add --no-cache iptables curl\n' | docker build -t archestra-egress-repro:test -
// Run with ARCHESTRA_TEST_SERVICE_EGRESS_CONTEXT=orbstack.
test.skipIf(process.env.ARCHESTRA_TEST_SERVICE_EGRESS_CONTEXT !== "orbstack")(
  "permits Service traffic before DNAT only after allowing its exact IP and port",
  async () => {
    const namespace = `runtime-egress-${randomUUID().slice(0, 8)}`;
    const image = "archestra-egress-repro:test";
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    kubeConfig.setCurrentContext("orbstack");
    const coreApi = kubeConfig.makeApiClient(CoreV1Api);
    const apply = (object: unknown) =>
      kubectl(["apply", "-f", "-"], JSON.stringify(object));
    const curl = (url: string) =>
      spawnSync(
        "kubectl",
        [
          "--context",
          "orbstack",
          "exec",
          "-n",
          namespace,
          "runtime",
          "-c",
          "agent-runtime",
          "--",
          "curl",
          "--noproxy",
          "*",
          "-s",
          "--connect-timeout",
          "2",
          "--max-time",
          "3",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `${url}/health`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    try {
      apply({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      });
      apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "api", namespace, labels: { app: "api" } },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "api",
              image,
              imagePullPolicy: "Never",
              command: [
                "node",
                "-e",
                "for (const port of [9000,9001]) require('http').createServer((q,s)=>s.end('healthy')).listen(port,'0.0.0.0')",
              ],
            },
          ],
        },
      });
      for (const name of ["api", "other"])
        apply({
          apiVersion: "v1",
          kind: "Service",
          metadata: { name, namespace },
          spec: {
            selector: { app: "api" },
            ports: [
              { name: "api", port: 8080, targetPort: 9000 },
              { name: "other", port: 8081, targetPort: 9001 },
            ],
          },
        });
      apply({
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        metadata: { name: "runtime", namespace },
        spec: {
          operatingMode: "Running",
          shutdownPolicy: "Retain",
          service: false,
          podTemplate: {
            metadata: {
              labels: { "archestra.io/agent-run-task-id": "test-task" },
            },
            spec: {
              automountServiceAccountToken: false,
              containers: [
                {
                  name: "agent-runtime",
                  image,
                  imagePullPolicy: "Never",
                  command: ["sleep", "infinity"],
                  securityContext: {
                    runAsUser: 0,
                    capabilities: { add: ["NET_ADMIN"] },
                  },
                },
              ],
            },
          },
        },
      });
      await expect
        .poll(
          () => {
            const result = spawnSync(
              "kubectl",
              [
                "--context",
                "orbstack",
                "get",
                "pods",
                "-n",
                namespace,
                "-o",
                "json",
              ],
              { encoding: "utf8" },
            );
            if (result.status !== 0) return false;
            const pods = JSON.parse(result.stdout).items;
            return (
              pods.length === 2 &&
              pods.every(
                (pod: {
                  status?: {
                    conditions?: Array<{ type: string; status: string }>;
                  };
                }) =>
                  pod.status?.conditions?.some(
                    (c) => c.type === "Ready" && c.status === "True",
                  ),
              )
            );
          },
          { timeout: 60_000, interval: 1000 },
        )
        .toBe(true);
      const baseUrl = `http://api.${namespace}.svc.cluster.local:8080`;
      const podIp = JSON.parse(
        kubectl(["get", "pod/api", "-n", namespace, "-o", "json"]),
      ).status.podIP;
      await expect
        .poll(() => curl(baseUrl).stdout, { timeout: 15_000 })
        .toBe("200");
      const spec = {
        frozenName: "runtime",
        namespace,
        taskId: "test-task",
        agentRuntimeId: "test-agent",
        ownerReferences: undefined,
        effectiveNetworkPolicy: { source: "built_in" as const, policy: null },
      };
      const floor = buildAgentRuntimeEnvironmentEgressPolicies({ spec })[0]
        .object as V1NetworkPolicy;
      const params = {
        spec,
        platformNamespace: namespace,
        platformPodLabels: { app: "api" },
        platformPorts: [9000],
      };
      const oldPolicy = buildAgentRuntimePlatformEgressPolicy(params);
      apply(floor);
      apply(oldPolicy);
      installPreDnatRules({
        namespace,
        policies: [floor, oldPolicy],
        first: true,
      });
      expect(curl(`http://${podIp}:9000`).stdout).toBe("200");
      const blocked = curl(baseUrl);
      expect(blocked.status).toBe(28);
      expect(blocked.stdout).toBe("000");
      const fixedPolicy = buildAgentRuntimePlatformEgressPolicy({
        ...params,
        platformService: await resolvePlatformServiceDestination({
          coreApi,
          baseUrl,
          platformNamespace: namespace,
          runtimeNamespace: namespace,
        }),
      });
      apply(fixedPolicy);
      installPreDnatRules({
        namespace,
        policies: [floor, fixedPolicy],
        first: false,
      });
      expect(curl(baseUrl).stdout).toBe("200");
      expect(curl(`http://${podIp}:9000`).stdout).toBe("200");
      expect(
        curl(`http://other.${namespace}.svc.cluster.local:8080`).status,
      ).toBe(28);
      expect(
        curl(`http://api.${namespace}.svc.cluster.local:8081`).status,
      ).toBe(28);
    } finally {
      kubectl([
        "delete",
        "namespace",
        namespace,
        "--ignore-not-found",
        "--wait=false",
      ]);
    }
  },
  120_000,
);

// Translate the generated IPv4 allow rules into a firewall inside this test
// pod only. OUTPUT/raw runs before the node translates ClusterIPs to endpoints.
function installPreDnatRules(params: {
  namespace: string;
  policies: V1NetworkPolicy[];
  first: boolean;
}) {
  const iptables = (args: string[]) =>
    kubectl([
      "exec",
      "-n",
      params.namespace,
      "runtime",
      "-c",
      "agent-runtime",
      "--",
      "iptables",
      "-t",
      "raw",
      ...args,
    ]);
  const chain = params.first ? "RUNTIME_OLD" : "RUNTIME_FIXED";
  iptables(["-N", chain]);
  let peerId = 0;
  for (const policy of params.policies)
    for (const rule of policy.spec?.egress ?? []) {
      for (const peer of rule.to ?? []) {
        let cidrs: string[];
        if (peer.ipBlock) {
          if (peer.ipBlock.cidr.includes(":")) continue;
          cidrs = [peer.ipBlock.cidr];
        } else {
          const namespace =
            peer.namespaceSelector?.matchLabels?.[
              "kubernetes.io/metadata.name"
            ] ?? params.namespace;
          const selector = Object.entries(peer.podSelector?.matchLabels ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join(",");
          const pods = JSON.parse(
            kubectl([
              "get",
              "pods",
              "-n",
              namespace,
              "-l",
              selector,
              "-o",
              "json",
            ]),
          );
          cidrs = pods.items
            .map((pod: { status: { podIP?: string } }) => pod.status.podIP)
            .filter((ip: string) => isIP(ip) === 4)
            .map((ip: string) => `${ip}/32`);
        }
        for (const cidr of cidrs) {
          const peerChain = `${chain}_${peerId++}`;
          iptables(["-N", peerChain]);
          for (const except of peer.ipBlock?.except ?? [])
            iptables(["-A", peerChain, "-d", except, "-j", "RETURN"]);
          iptables(["-A", peerChain, "-j", "ACCEPT"]);
          for (const port of rule.ports?.length ? rule.ports : [undefined])
            iptables([
              "-A",
              chain,
              "-d",
              cidr,
              ...(port
                ? [
                    "-p",
                    (port.protocol ?? "TCP").toLowerCase(),
                    "--dport",
                    String(port.port),
                  ]
                : []),
              "-j",
              peerChain,
            ]);
        }
      }
    }
  iptables(["-A", chain, "-j", "DROP"]);
  iptables(["-I", "OUTPUT", "1", "-j", chain]);
  if (!params.first) iptables(["-D", "OUTPUT", "-j", "RUNTIME_OLD"]);
}

function kubectl(args: string[], input?: string): string {
  return execFileSync("kubectl", ["--context", "orbstack", ...args], {
    encoding: "utf8",
    input,
    timeout: 20_000,
  }).trim();
}
