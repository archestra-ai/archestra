import { SecretsManagerType } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import secretsRoutes from "./secrets";

describe("secret storage API", () => {
  const ctx = useRouteTestApp(secretsRoutes);

  test("reports database storage and checks connectivity without exposing stored credentials", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "private-api-key" } });
    const storage = await ctx.app.inject({
      method: "GET",
      url: "/api/secrets/type",
    });
    expect(storage.statusCode).toBe(200);
    expect(storage.json().type).toBe(SecretsManagerType.DB);

    const connectivity = await ctx.app.inject({
      method: "POST",
      url: "/api/secrets/check-connectivity",
    });
    expect(connectivity.statusCode).toBe(200);
    expect(connectivity.json().secretCount).toBeGreaterThanOrEqual(1);

    const value = await ctx.app.inject({
      method: "GET",
      url: `/api/secrets/${secret.id}`,
    });
    expect(value.statusCode).toBe(404);
    expect(value.body).not.toContain("private-api-key");
  });
});
