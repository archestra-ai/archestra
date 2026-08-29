import { vi } from "vitest";
import { describe, expect, test, useRouteTestApp } from "@/test";
import bundleRoutes from "./bundle.routes";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    bundles: { enabled: false },
  }),
);

describe("Bundle routes feature gate", () => {
  const ctx = useRouteTestApp(bundleRoutes);

  test("returns 404 while Bundles are disabled", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/bundles",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Bundles are not enabled");
  });
});
