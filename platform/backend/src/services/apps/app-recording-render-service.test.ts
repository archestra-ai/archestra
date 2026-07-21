import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import {
  INTERNAL_RENDER_BASE,
  RENDER_USER_ID_HEADER,
} from "./app-recording-render-protocol";
import renderServiceRoutes from "./app-recording-render-service";

/**
 * The render service's own contract, exercised without driving a browser: the
 * cases here never start a render. What they pin is the trust boundary — the
 * web tier forwards a user, and the service enforces per-render ownership from
 * it — which is the whole reason a job id can be handed back to the browser at
 * all.
 */
describe("app-recording render service (internal)", () => {
  const ctx = useRouteTestApp(renderServiceRoutes);

  test("refuses a request that carries no forwarded user", async () => {
    // Only the web tier reaches these routes and it always forwards the
    // authenticated user, so a request without one never came from it.
    const res = await ctx.app.inject({
      method: "POST",
      url: INTERNAL_RENDER_BASE,
      payload: { bundle: {}, title: "Demo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("Missing render user");
  });

  test("a status poll still needs the forwarded user", async () => {
    // The user is checked before the job is looked up — an id alone is not
    // enough to ask after someone's render.
    const res = await ctx.app.inject({
      method: "GET",
      url: `${INTERNAL_RENDER_BASE}/00000000-0000-4000-8000-0000000000ab`,
    });
    expect(res.statusCode).toBe(400);
  });

  test("reports an unknown job as not found", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${INTERNAL_RENDER_BASE}/00000000-0000-4000-8000-0000000000ab`,
      headers: { [RENDER_USER_ID_HEADER]: "user-1" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("cancelling an unknown job is a not-found, not a crash", async () => {
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `${INTERNAL_RENDER_BASE}/00000000-0000-4000-8000-0000000000ab`,
      headers: { [RENDER_USER_ID_HEADER]: "user-1" },
    });
    expect(res.statusCode).toBe(404);
  });
});
