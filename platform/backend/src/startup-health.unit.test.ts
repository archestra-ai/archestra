import { once } from "node:events";
import { connect } from "node:net";
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
