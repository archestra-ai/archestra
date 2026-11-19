import { createFastifyInstance } from "@/fastify-instance";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import xaiProxyRoutes from "./xai";

setupTestCacheManager();

test.for([
  { method: "GET", suffix: "models", withAgent: false },
  { method: "GET", suffix: "settings", withAgent: true },
  { method: "PUT", suffix: "privacy/coding-data-retention", withAgent: false },
  { method: "PUT", suffix: "privacy/coding-data-retention", withAgent: true },
] as const)("native $method $suffix rate-limits failed platform credentials (agent=$withAgent)", async ({
  method,
  suffix,
  withAgent,
}, { makeAgent, makeUser, makeMember }) => {
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const app = createFastifyInstance();
  await app.register(xaiProxyRoutes);
  const send = () =>
    app.inject({
      method,
      url: `/v1/xai${withAgent ? `/${agent.id}` : ""}/native/${suffix}`,
      headers: {
        authorization: "Bearer synthetic-native-access",
        "x-archestra-grok-credential-mode": "native-session",
        "x-archestra-virtual-key": `${token}invalid`,
      },
      ...(method === "PUT"
        ? { payload: { codingDataRetentionOptOut: true } }
        : {}),
    });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const denied = await send();
      expect(denied.statusCode, denied.body).toBe(401);
    }
    const limited = await send();
    expect(limited.statusCode, limited.body).toBe(429);
  } finally {
    await app.close();
  }
});
