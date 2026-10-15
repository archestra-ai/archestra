import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import Fastify from "fastify";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { createStartupHealthServer } from "./startup-health";

test("upgrade liveness succeeds while readiness and application traffic stay unavailable", async () => {
  const server = createStartupHealthServer();
  try {
    expect((await server.inject("/health")).statusCode).toBe(200);
    for (const url of ["/ready", "/api/profiles", "/v1/mcp/example"]) {
      expect((await server.inject(url)).statusCode).toBe(503);
    }
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/profiles",
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    await server.close();
  }
});

test("the API can take over the port even with an unfinished startup request", async () => {
  const startup = createStartupHealthServer();
  await startup.listen({ port: 0, host: "127.0.0.1" });
  const address = startup.server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  const socket = connect(address.port, "127.0.0.1");
  try {
    await once(socket, "connect");
    const requestStarted = new Promise<void>((resolve) => {
      startup.server.once("request", () => resolve());
    });
    socket.write(
      "POST /api/profiles HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
    );
    await requestStarted;
    await startup.close();
    const api = createStartupHealthServer();
    try {
      await api.listen({ port: address.port, host: "127.0.0.1" });
      expect((await api.inject("/health")).statusCode).toBe(200);
    } finally {
      await api.close();
    }
  } finally {
    socket.destroy();
    await startup.close();
  }
});

test("Quickstart waits for the application API before asserting loopback connectivity", async () => {
  const workflow = load(
    readFileSync(
      new URL(
        "../../../.github/workflows/platform-e2e-tests.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const waitStep = workflow.jobs["platform-quickstart-e2e-tests"].steps.find(
    (step) => step.name === "Wait for platform to be healthy",
  );
  if (!waitStep?.run) throw new Error("Quickstart backend wait step not found");

  const startup = createStartupHealthServer();
  let readinessRequested = () => {};
  const readinessProbe = new Promise<void>((resolve) => {
    readinessRequested = resolve;
  });
  startup.addHook("onResponse", (request, _reply, done) => {
    if (request.url === "/ready") readinessRequested();
    done();
  });
  await startup.listen({ port: 0, host: "127.0.0.1" });
  const address = startup.server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  const origin = `http://127.0.0.1:${address.port}`;
  // Run the workflow's actual backend gate against an isolated TCP port.
  // Leave its readiness polling intact, excluding only the later frontend gate.
  const script = waitStep.run
    .split("# Wait for frontend")[0]
    .replaceAll("http://127.0.0.1:9000", origin);
  const child = spawn("bash", ["-e", "-o", "pipefail", "-c", script]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const api = Fastify();
  try {
    // Liveness already succeeds, but it must not release application assertions.
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect(
      await Promise.race([
        readinessProbe.then(() => "readiness"),
        completed.then(() => "premature completion"),
      ]),
    ).toBe("readiness");

    await startup.close();
    api.get("/ready", async () => ({ status: "ok" }));
    api.get("/health", async () => ({ status: "ok" }));
    await api.listen({ port: address.port, host: "127.0.0.1" });
    expect(await completed, output).toBe(0);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  } finally {
    child.kill("SIGKILL");
    await completed.catch(() => {});
    await startup.close();
    await api.close();
  }
});
