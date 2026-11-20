import ManagedOauthClientModel from "@/models/managed-oauth-client";
import { expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./oauth-client.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest route fixture registration, not a React hook.
const ctx = useRouteTestApp(routes);

test("returns a client its author can see, and 404 for one they cannot", async ({
  makeMember,
  makeUser,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    name: "support bot",
    scopes: ["mcp"],
  });
  const other = await makeUser();
  await makeMember(other.id, ctx.organizationId, { role: "member" });
  const { oauthClient: hidden } = await ManagedOauthClientModel.create({
    organizationId: ctx.organizationId,
    authorId: other.id,
    name: "someone else's",
    scopes: ["mcp"],
  });

  const own = await ctx.app.inject({
    method: "GET",
    url: `/api/oauth-clients/${oauthClient.id}`,
  });
  expect(own.statusCode, own.body).toBe(200);
  expect(own.json()).toMatchObject({
    id: oauthClient.id,
    name: "support bot",
    scopes: ["mcp"],
  });

  const notVisible = await ctx.app.inject({
    method: "GET",
    url: `/api/oauth-clients/${hidden.id}`,
  });
  expect(notVisible.statusCode).toBe(404);
});
