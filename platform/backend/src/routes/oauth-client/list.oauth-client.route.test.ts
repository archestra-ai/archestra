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
