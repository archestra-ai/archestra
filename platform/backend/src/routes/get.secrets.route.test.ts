import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import secretsRoutes from "./secrets";

describe("GET /api/secrets/:id", () => {
  const ctx = useRouteTestApp(secretsRoutes);

  test("returns a registry entry's Vault references only to people who can edit that entry", async ({
    makeMember,
    makeUser,
    makeSecret,
    makeInternalMcpCatalog,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const byosSecret = () =>
      makeSecret({
        secret: { token: "vault/data/mcp#token" },
        isByosVault: true,
      } as never);

    const editable = await byosSecret();
    await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      localConfigSecretId: editable.id,
      access: { users: [ctx.user.id], preset: "edit" },
    });
    // An entry only someone else can edit.
    const readOnly = await byosSecret();
    await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      localConfigSecretId: readOnly.id,
      access: { users: [other.id], preset: "edit" },
    });
    const unattached = await byosSecret();

    const get = (id: string) =>
      ctx.app.inject({ method: "GET", url: `/api/secrets/${id}` });

    const allowed = await get(editable.id);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().secret).toEqual({ token: "vault/data/mcp#token" });
    // Secrets the caller can't edit through an entry read as missing.
    expect((await get(readOnly.id)).statusCode).toBe(404);
    expect((await get(unattached.id)).statusCode).toBe(404);
  });
});
