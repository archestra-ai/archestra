import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { expect, test } from "vitest";
import config from "@/config";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import { buildAgentRuntimePlatformEgressPolicy } from "./manifests";
import { AGENT_RUNTIME_TASK_LABEL } from "./naming";
import { buildAgentRuntimeEnvironmentEgressPolicies } from "./network-policy";

// Opt in on a disposable Kind cluster with an enforcing CNI and a separate
// KUBECONFIG. Load python:3.13-alpine with `kind load docker-image` first.
// ARCHESTRA_TEST_DNS_EGRESS_CONTEXT=kind-runtime-dns-proof pnpm --dir backend exec vitest run src/k8s/agent-runtime/dns-egress.cluster.test.ts
const context = process.env.ARCHESTRA_TEST_DNS_EGRESS_CONTEXT;
test.skipIf(!context)(
  "restricts runtime UDP and TCP DNS while keeping known resolvers reachable",
  async () => {
    if (!context?.startsWith("kind-") || !process.env.KUBECONFIG) {
      throw new Error(
        "Use a disposable Kind cluster and an explicit KUBECONFIG",
      );
    }
    const namespace = `runtime-dns-${randomUUID().slice(0, 8)}`;
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromFile(process.env.KUBECONFIG);
    kubeConfig.setCurrentContext(context);
    const coreApi = kubeConfig.makeApiClient(CoreV1Api);
    const kubectl = (args: string[], input?: string) =>
      execFileSync("kubectl", ["--context", context, ...args], {
        encoding: "utf8",
        input,
        timeout: 60_000,
      });
    const apply = (object: unknown) =>
      kubectl(["apply", "-f", "-"], JSON.stringify(object));
    const query = (pod: string, destination: string, protocol: string) =>
      spawnSync(
        "kubectl",
        [
          "--context",
          context,
          "exec",
          "-n",
          namespace,
          pod,
          "--",
          "python",
          "-c",
          DNS_QUERY,
          destination,
          protocol,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    const check = (pod: string, destination: string, allowed: boolean) => {
      const results = ["UDP", "TCP"].map((protocol) => {
        const result = query(pod, destination, protocol);
        return {
          protocol,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      });
      for (const result of results) {
        // Exit 2 means the DNS query timed out. Other errors are failed
        // prerequisites, never evidence of successful enforcement.
        expect(result.status, JSON.stringify(results)).toBe(allowed ? 0 : 2);
        if (allowed) expect(result.stdout.trim()).toBe("DNS_RESPONSE");
      }
    };
    try {
      apply({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      });
      for (const name of ["resolver", "collector", "runtime", "control"]) {
        apply({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            namespace,
            labels: { [AGENT_RUNTIME_TASK_LABEL]: name },
          },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name,
                image: "python:3.13-alpine",
                imagePullPolicy: "Never",
                command: ["python", "-u", "-c", DNS_SERVER],
                resources: {
                  requests: { cpu: "10m", memory: "16Mi" },
                  limits: { memory: "64Mi" },
                },
              },
            ],
          },
        });
      }
      kubectl([
        "wait",
        "-n",
        namespace,
        "--for=condition=Ready",
        "pod",
        "--all",
        "--timeout=60s",
      ]);
      const podIp = (name: string) =>
        kubectl([
          "get",
          "pod",
          name,
          "-n",
          namespace,
          "-o",
          "jsonpath={.status.podIP}",
        ]);
      const resolver = podIp("resolver");
      const collector = podIp("collector");
      check("runtime", resolver, true);
      check("runtime", collector, true);

      const spec = {
        frozenName: "runtime",
        namespace,
        taskId: "runtime",
        agentRuntimeId: "dns-proof",
        effectiveNetworkPolicy: {
          source: "environment" as const,
          policy: {
            egressMode: "restricted" as const,
            domainPreset: "none" as const,
            allowedDomains: [],
            allowedCidrs: [],
          },
        },
      };
      const [environmentPolicy] = buildAgentRuntimeEnvironmentEgressPolicies({
        spec,
      });
      apply(environmentPolicy.object);
      // An actual denial plus an unaffected positive control is mandatory:
      // accepting NetworkPolicy objects alone proves nothing about the CNI.
      await expect
        .poll(() => query("runtime", collector, "UDP").status, {
          timeout: 30_000,
        })
        .toBe(2);
      check("runtime", collector, false);
      check("control", collector, true);

      const platformPolicy = (ips: string[]) =>
        buildAgentRuntimePlatformEgressPolicy({
          spec,
          platformNamespace: namespace,
          platformPodLabels: { app: "platform-api" },
          platformPorts: [9000],
          clusterDnsIps: ips,
        });
      // Exercise real Service discovery, including DNS through the Service IP.
      config.orchestrator.kubernetes.clusterDnsIps = [];
      clusterDnsResolver.clearCache();
      const discovered = await clusterDnsResolver.getClusterDnsIps(coreApi);
      expect(discovered.length).toBeGreaterThan(0);
      apply(platformPolicy(discovered));
      for (const ip of discovered) check("runtime", ip, true);
      check("runtime", collector, false);
      process.stdout.write(
        "PASS discovered cluster DNS: UDP/TCP allowed; collector denied\n",
      );

      // This resolver has no kube-dns labels. Only the existing IP override
      // can permit it, proving the exact-IP path independently of selectors.
      config.orchestrator.kubernetes.clusterDnsIps = [resolver];
      const configured = await clusterDnsResolver.getClusterDnsIps(coreApi);
      apply(platformPolicy(configured));
      await expect
        .poll(() => query("runtime", resolver, "UDP").status, {
          timeout: 30_000,
        })
        .toBe(0);
      check("runtime", resolver, true);
      check("runtime", collector, false);
      check("control", collector, true);
      process.stdout.write(
        "PASS configured unlabelled DNS: UDP/TCP allowed; collector denied\n",
      );

      apply(platformPolicy([]));
      await expect
        .poll(() => query("runtime", resolver, "UDP").status, {
          timeout: 30_000,
        })
        .toBe(2);
      check("runtime", resolver, false);
      check("runtime", collector, false);
      // The labelled cluster DNS selector survives unknown resolver IPs.
      for (const ip of discovered) check("runtime", ip, true);
      check("control", collector, true);
      process.stdout.write(
        "PASS unknown DNS: arbitrary UDP/TCP denied; labelled kube-dns allowed\n",
      );
    } finally {
      clusterDnsResolver.clearCache();
      kubectl([
        "delete",
        "namespace",
        namespace,
        "--ignore-not-found",
        "--wait=false",
      ]);
    }
  },
  180_000,
);

// A real DNS A response for a synthetic query, with no third-party traffic.
const DNS_SERVER = String.raw`
import socket, struct, threading

def answer(data):
    return data[:2] + b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00' + data[12:] + b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x01\x00\x04\xc0\x00\x02\x35'

def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(('0.0.0.0', 53))
    while True:
        data, peer = s.recvfrom(4096)
        s.sendto(answer(data), peer)

threading.Thread(target=udp, daemon=True).start()
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 53))
s.listen()
while True:
    c, _ = s.accept()
    with c:
        c.settimeout(3)
        stream = c.makefile('rb')
        length = struct.unpack('!H', stream.read(2))[0]
        response = answer(stream.read(length))
        c.sendall(struct.pack('!H', len(response)) + response)
`;

const DNS_QUERY = String.raw`
import socket, struct, sys, secrets
identifier = secrets.token_bytes(2)
name = b'\x0akubernetes\x07default\x03svc\x07cluster\x05local\x00'
query = identifier + b'\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00' + name + b'\x00\x01\x00\x01'
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if sys.argv[2] == 'UDP' else socket.SOCK_STREAM)
s.settimeout(1)
try:
    if sys.argv[2] == 'UDP':
        s.sendto(query, (sys.argv[1], 53))
        response, _ = s.recvfrom(4096)
    else:
        s.connect((sys.argv[1], 53))
        s.sendall(struct.pack('!H', len(query)) + query)
        stream = s.makefile('rb')
        length = struct.unpack('!H', stream.read(2))[0]
        response = stream.read(length)
    assert response[:2] == identifier and response[2] & 128 and response[3] & 15 == 0
    assert struct.unpack('!H', response[6:8])[0] > 0
    print('DNS_RESPONSE')
except TimeoutError:
    sys.exit(2)
finally:
    s.close()
`;
