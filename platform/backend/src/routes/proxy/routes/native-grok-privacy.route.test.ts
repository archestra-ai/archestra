import { createServer } from "node:http";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import InteractionModel from "@/models/interaction";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import xaiProxyRoutes from "./xai";

setupTestCacheManager();

test("native privacy updates only the requested preference, records its real diff, and preserves vendor denials", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  let optOut = false,
    deny = false;
  const calls: {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }[] = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/native/user" && request.method === "GET") {
      response.end(
        JSON.stringify({
          userId: "synthetic-native-user",
          codingDataRetentionOptOut: optOut,
          unrelated: "must-not-enter-audit",
        }),
      );
    } else if (
      request.url === "/native/privacy/coding-data-retention" &&
      request.method === "PUT"
    ) {
      if (deny) {
        response.writeHead(403).end('{"error":"synthetic-private-rejection"}');
        return;
      }
      optOut = JSON.parse(body).codingDataRetentionOptOut;
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const previous = config.llm.xai.subscription.baseUrl;
  config.llm.xai.subscription.baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/native`;
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const headers = {
    authorization: "Bearer synthetic-native-access",
    "x-archestra-virtual-key": token,
    "x-archestra-grok-credential-mode": "native-session",
    cookie: "synthetic=private",
  };
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  try {
    for (const [prefix, desired] of [
      ["/v1/xai", true],
      [`/v1/xai/${agent.id}`, false],
    ] as const) {
      const result = await app.inject({
        method: "PUT",
        url: `${prefix}/native/privacy/coding-data-retention`,
        headers,
        payload: { codingDataRetentionOptOut: desired },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ codingDataRetentionOptOut: desired });
      expect(optOut).toBe(desired);
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    let audit = await AuditLogModel.findPaginated({
      organizationId: agent.organizationId,
      limit: 10,
      offset: 0,
      action: "clientPrivacy.updated",
    });
    expect(audit.data).toHaveLength(2);
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: user.id,
          action: "clientPrivacy.updated",
          outcome: "success",
          before: { clientId: "grok-build", codingDataRetentionOptOut: false },
          after: { clientId: "grok-build", codingDataRetentionOptOut: true },
        }),
        expect.objectContaining({
          before: { clientId: "grok-build", codingDataRetentionOptOut: true },
          after: { clientId: "grok-build", codingDataRetentionOptOut: false },
        }),
      ]),
    );
    const count = calls.length;
    for (const payload of [
      { codingDataRetentionOptOut: "true" },
      {
        codingDataRetentionOptOut: true,
        upstream: "https://unrelated.invalid",
      },
      {},
    ]) {
      const result = await app.inject({
        method: "PUT",
        url: "/v1/xai/native/privacy/coding-data-retention",
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
    }
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      expect(
        (
          await app.inject({
            method,
            url: "/v1/xai/native/privacy/coding-data-retention",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/xai/native/privacy/coding-data-retention",
          headers: { ...headers, "x-archestra-virtual-key": "invalid" },
          payload: { codingDataRetentionOptOut: true },
        })
      ).statusCode,
    ).toBe(401);
    expect(calls).toHaveLength(count);
    deny = true;
    const denied = await app.inject({
      method: "PUT",
      url: "/v1/xai/native/privacy/coding-data-retention",
      headers,
      payload: { codingDataRetentionOptOut: true },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).not.toContain("synthetic-private-rejection");
    expect(optOut).toBe(false);
    audit = await AuditLogModel.findPaginated({
      organizationId: agent.organizationId,
      limit: 10,
      offset: 0,
      action: "clientPrivacy.updated",
    });
    expect(audit.data).toContainEqual(
      expect.objectContaining({ outcome: "denied", after: null }),
    );
    expect(JSON.stringify(audit)).not.toContain("must-not-enter-audit");
    expect(JSON.stringify(audit)).not.toContain("synthetic-native-access");
    expect(
      calls.every(
        (call) =>
          call.headers.authorization === "Bearer synthetic-native-access" &&
          !call.headers.cookie &&
          !call.headers["x-archestra-virtual-key"],
      ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.method === "PUT")
        .map((call) => JSON.parse(call.body)),
    ).toEqual([
      { codingDataRetentionOptOut: true },
      { codingDataRetentionOptOut: false },
      { codingDataRetentionOptOut: true },
    ]);
    expect(
      (await InteractionModel.findAllPaginated({ limit: 10, offset: 0 })).data,
    ).toEqual([]);
  } finally {
    config.llm.xai.subscription.baseUrl = previous;
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
