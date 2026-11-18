import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import {
  clusterAgentKubeconfig,
  normalizeClusterAgentUrl,
  openClusterAgentPodStream,
  readClusterAgentCredential,
} from "./cluster-agent";

describe("normalizeClusterAgentUrl", () => {
  test("keeps one spelling of the agent's address", () => {
    expect(normalizeClusterAgentUrl(" https://Agent.Example.com:8443/ ")).toBe(
      "https://agent.example.com:8443",
    );
    expect(normalizeClusterAgentUrl("https://agent.example.com:443/b/")).toBe(
      "https://agent.example.com/b",
    );
  });

  test("refuses what is not an agent address", () => {
    for (const url of [
      "agent.example.com",
      "http://agent.example.com",
      "ftp://agent.example.com",
      "https://agent.example.com/?x=1",
      "https://user:pass@agent.example.com",
    ]) {
      expect(() => normalizeClusterAgentUrl(url)).toThrow();
    }
  });
});

describe("clusterAgentKubeconfig", () => {
  test("points the Kubernetes clients at the agent with its token", () => {
    const kubeconfig = clusterAgentKubeconfig({
      url: "https://agent.example.com",
      token: "agent-token",
    });
    expect(kubeconfig).toContain('server: "https://agent.example.com/k8s"');
    expect(kubeconfig).toContain('token: "agent-token"');
    expect(kubeconfig).not.toContain("insecure-skip-tls-verify");
  });

  test("trusts the agent's private CA when one is stored", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    expect(
      clusterAgentKubeconfig({ url: "https://agent.internal", token: "t", ca }),
    ).toContain(
      `certificate-authority-data: ${Buffer.from(ca).toString("base64")}`,
    );
  });
});

describe("readClusterAgentCredential", () => {
  test("reads the stored token and CA and nothing else", () => {
    expect(readClusterAgentCredential({ clusterAgentToken: "t" })).toEqual({
      token: "t",
    });
    expect(
      readClusterAgentCredential({
        clusterAgentToken: "t",
        clusterAgentCa: "c",
      }),
    ).toEqual({ token: "t", ca: "c" });
    expect(readClusterAgentCredential({ kubeconfig: "x" })).toBeUndefined();
    expect(readClusterAgentCredential(null)).toBeUndefined();
  });
});

describe("openClusterAgentPodStream", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /** A stand-in agent: answers the upgrade, then echoes the stream. */
  async function fakeAgent(
    answer: (request: http.IncomingMessage, socket: Duplex) => void,
  ): Promise<string> {
    const server = http.createServer();
    server.on("upgrade", (request, socket) => answer(request, socket));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("opens a stream to the pod port and carries bytes both ways", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const paths: (string | undefined)[] = [];
    const url = await fakeAgent((request, socket) => {
      seen.push(request.headers);
      paths.push(request.url);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: archestra-pod-stream\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.pipe(socket);
    });

    const stream = await openClusterAgentPodStream(
      { url, token: "agent-token" },
      { namespace: "mcp", pod: "server-1", port: 8080 },
    );
    const echoed = new Promise<string>((resolve) =>
      stream.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    stream.write("ping");

    expect(await echoed).toBe("ping");
    expect(paths[0]).toBe("/pods/mcp/server-1/8080");
    expect(seen[0].authorization).toBe("Bearer agent-token");
    expect(seen[0].upgrade).toBe("archestra-pod-stream");
    stream.destroy();
  });

  test("reports why the agent refused", async () => {
    const url = await fakeAgent((_request, socket) => {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nforbidden",
      );
    });
    await expect(
      openClusterAgentPodStream(
        { url, token: "agent-token" },
        { namespace: "kube-system", pod: "etcd", port: 2379 },
      ),
    ).rejects.toThrow(/refused a stream.*403.*forbidden/);
  });
});
