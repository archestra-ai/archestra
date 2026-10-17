import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import { expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./oauth-client.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest route fixture registration, not a React hook.
const ctx = useRouteTestApp(routes);

test("capability filters include combined clients and paginate the matching set", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  for (const [name, scopes] of [
    ["Gateway only", ["mcp"]],
    ["Inference only", ["llm:proxy"]],
    ["Combined", ["mcp", "a2a", "llm:proxy"]],
  ] as const) {
    await ManagedOauthClientModel.create({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name,
      scopes: [...scopes],
    });
  }
  const load = (query: string) =>
    ctx.app.inject({ method: "GET", url: `/api/oauth-clients?${query}` });
  const mcp = await load("capability=mcp&limit=1");
  expect(mcp.statusCode).toBe(200);
  expect(mcp.json().data).toHaveLength(1);
  expect(mcp.json().pagination.total).toBe(2);
  const next = await load("capability=mcp&limit=1&offset=1");
  expect(next.json().pagination.total).toBe(2);
  expect(next.json().data[0].id).not.toBe(mcp.json().data[0].id);
  const llm = await load("capability=llm%3Aproxy");
  expect(
    llm
      .json()
      .data.map((client: { name: string }) => client.name)
      .sort(),
  ).toEqual(["Combined", "Inference only"]);
  expect(llm.json().pagination.total).toBe(2);
  const a2a = await load("capability=a2a");
  expect(
    a2a.json().data.map((client: { name: string }) => client.name),
  ).toEqual(["Combined"]);
  expect((await load("capability=unknown")).statusCode).toBe(400);
});

test("applicableTo keeps clients that can reach the target over its protocol", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const agent = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "agent",
  });
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "mcp_gateway",
  });
  const other = await makeAgent({ organizationId: ctx.organizationId });
  const create = (
    name: string,
    params: Partial<Parameters<typeof ManagedOauthClientModel.create>[0]>,
  ) =>
    ManagedOauthClientModel.create({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name,
      scopes: ["a2a"],
      ...params,
    });
  const signedIn = {
    grantType: "authorization_code" as const,
    redirectUris: ["https://example.com/callback"],
  };
  await create("Users over A2A", signedIn);
  await create("Users over MCP", { ...signedIn, scopes: ["mcp"] });
  await create("Lists both", {
    scopes: ["a2a", "mcp"],
    allowedGatewayIds: [agent.id, gateway.id],
  });
  await create("Lists another agent", { allowedGatewayIds: [other.id] });
  await create("Inference only", { ...signedIn, scopes: ["llm:proxy"] });
  // A pre-A2A MCP client: its mcp scope also reaches agents.
  const legacy = await create("Legacy MCP client", {
    scopes: ["mcp"],
    allowedGatewayIds: [agent.id],
  });
  await db
    .update(schema.oauthClientsTable)
    .set({
      metadata: sql`jsonb_set(${schema.oauthClientsTable.metadata}, '{type}', '"mcp_oauth_client"')`,
    })
    .where(eq(schema.oauthClientsTable.id, legacy.oauthClient.id));

  const names = async (targetId: string) => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/oauth-clients?applicableTo=${targetId}&limit=100`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagination.total).toBe(body.data.length);
    return body.data.map((client: { name: string }) => client.name).sort();
  };

  expect(await names(agent.id)).toEqual([
    "Legacy MCP client",
    "Lists both",
    "Users over A2A",
  ]);
  expect(await names(gateway.id)).toEqual(["Lists both", "Users over MCP"]);
});
